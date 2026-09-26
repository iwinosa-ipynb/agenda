import "server-only";

import { prisma } from "@/lib/prisma";
import { getPaymentProvider } from "@/services/payments/index";
import { transitionObligation } from "@/services/payments/obligation-state.service";
import type { VerificationRequest, VerificationResult } from "@/services/payments/index";

/**
 * Stage 14B — funding verification (THE FUNDED gate).
 *
 * Server-side provider verification is the ONLY proof that can drive an
 * obligation to FUNDED. Webhook payloads are HINTS that trigger verification;
 * they are never the authority for amounts. Valid funding requires ALL of:
 *   - provider verification returns "verified";
 *   - verified amount === obligation.advertiserTotalMinor (BigInt kobo);
 *   - verified currency === obligation.currency.
 *
 * Idempotency: re-verification of an already-FUNDED obligation is a no-op
 * (`idempotentReplay: true`) — never a second set of ledger entries. The
 * 13A executor's conditional update + unique event/ledger keys arbitrate all
 * races; this module creates NO second state machine.
 *
 * Timeout/network uncertainty during verification NEVER transitions to
 * FAILED: the obligation stays PROCESSING for reconciliation/webhooks.
 */

export type VerificationGateErrorCode =
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "PROVIDER_UNCONFIGURED"
  | "UNVERIFIED"
  | "AMOUNT_MISMATCH"
  | "CURRENCY_MISMATCH"
  | "PROVIDER_UNAVAILABLE"
  | "VERIFICATION_FAILED";

export type VerifyFundingResult =
  | {
      ok: true;
      obligationId: string;
      status: "FUNDED" | "FAILED" | "PROCESSING";
      /** True when the obligation was already in the returned state (no-op). */
      idempotentReplay: boolean;
      providerReference: string;
    }
  | { ok: false; code: VerificationGateErrorCode; reason: string };

/** The 13A ledger shape for provider-verified funding (pinned by 13A tests). */
function fundingLedgerEntries(input: {
  advertiserId: string;
  creatorAmountMinor: bigint;
  platformFeeMinor: bigint;
  advertiserTotalMinor: bigint;
  currency: string;
  providerReference: string;
}) {
  return [
    {
      account: `advertiser:${input.advertiserId}:payable`,
      direction: "DEBIT" as const,
      amountMinor: input.advertiserTotalMinor,
      currency: input.currency,
      entryType: "CHARGE" as const,
      providerReference: input.providerReference,
    },
    {
      account: "platform:escrow",
      direction: "CREDIT" as const,
      amountMinor: input.creatorAmountMinor,
      currency: input.currency,
      entryType: "ESCROW_HOLD" as const,
      providerReference: input.providerReference,
    },
    {
      account: "platform:revenue",
      direction: "CREDIT" as const,
      amountMinor: input.platformFeeMinor,
      currency: input.currency,
      entryType: "PLATFORM_FEE" as const,
      providerReference: input.providerReference,
    },
  ];
}

/** Update the attempt row's provider status (evidence, never authority). */
async function recordAttemptStatus(
  obligationId: string,
  providerReference: string,
  providerStatus: "SUCCEEDED" | "FAILED" | "PENDING",
  secretFreeMetadata?: Record<string, unknown>,
): Promise<void> {
  const existing = await prisma.paymentProviderTransaction.findFirst({
    where: { obligationId, providerReference },
    select: { id: true },
  });

  if (!existing) {
    return;
  }

  await prisma.paymentProviderTransaction.updateMany({
    where: { id: existing.id },
    data: {
      providerStatus,
      ...(providerStatus === "PENDING" ? {} : { confirmedAt: new Date() }),
      ...(secretFreeMetadata !== undefined
        ? { metadata: secretFreeMetadata as Record<string, string> }
        : {}),
    },
  });
}

/**
 * Resolve the provider for a verification call, or null in dormant mode.
 * `providerOverride` is a TEST seam only — never exposed to actions.
 */
async function resolveProvider(
  providerOverride?: (request: VerificationRequest) => Promise<VerificationResult>,
) {
  if (providerOverride) {
    return providerOverride;
  }

  try {
    const provider = getPaymentProvider();

    return (request: VerificationRequest) => provider.verifyTransaction(request);
  } catch {
    return null;
  }
}

/**
 * Verify the payment for one obligation server-side and drive the outcome
 * through the 13A state machine.
 *
 * Outcomes:
 *   - verified + amount/currency match → PROCESSING → FUNDED with the 13A
 *     ledger lines (CHARGE / ESCROW_HOLD / PLATFORM_FEE);
 *   - provider definitively reports failure → PROCESSING → FAILED
 *     (no ledger lines — no money moved);
 *   - amount/currency mismatch → UNVERIFIED refusal, obligation stays
 *     PROCESSING (never FAILED — a mismatch is not a payment failure);
 *   - provider unavailable/timeout → obligation stays PROCESSING for
 *     reconciliation and webhook retries (timeout ≠ failure).
 */
export async function verifyAndSettleFunding(
  obligationId: string,
  providerOverride?: (request: VerificationRequest) => Promise<VerificationResult>,
): Promise<VerifyFundingResult> {
  const obligation = await prisma.financialObligation.findUnique({
    where: { id: obligationId },
    select: {
      id: true,
      obligationRef: true,
      status: true,
      advertiserId: true,
      creatorAmountMinor: true,
      platformFeeMinor: true,
      advertiserTotalMinor: true,
      currency: true,
      providerReference: true,
      dispute: true,
    },
  });

  if (!obligation) {
    return { ok: false, code: "NOT_FOUND", reason: "Obligation not found." };
  }

  // Idempotency before any provider call: already-resolved obligations are
  // never re-verified into a second transition or second ledger set.
  if (obligation.status === "FUNDED") {
    return {
      ok: true,
      obligationId: obligation.id,
      status: "FUNDED",
      idempotentReplay: true,
      providerReference: obligation.providerReference ?? "",
    };
  }

  if (obligation.status === "FAILED") {
    return {
      ok: true,
      obligationId: obligation.id,
      status: "FAILED",
      idempotentReplay: true,
      providerReference: obligation.providerReference ?? "",
    };
  }

  if (obligation.status !== "PROCESSING") {
    return {
      ok: false,
      code: "INVALID_STATE",
      reason:
        obligation.status === "PENDING_PAYMENT"
          ? "Payment has not been initiated yet."
          : `Obligation is ${obligation.status} — verification applies only to PROCESSING payments.`,
    };
  }

  const provider = await resolveProvider(providerOverride);

  if (!provider) {
    return {
      ok: false,
      code: "PROVIDER_UNCONFIGURED",
      reason: "No payment provider is configured yet.",
    };
  }

  // The provider reference: the deterministic business reference sent to
  // Paystack at initiation is the obligationRef.
  const providerReference = obligation.obligationRef;

  const result = await provider({
    providerReference,
    expectedAmountMinor: obligation.advertiserTotalMinor,
    currency: obligation.currency,
  });

  if (result.status === "verified") {
    // Defense in depth: re-check the gate here even though the adapter also
    // compares — the OBLIGATION row is the authority, not the adapter input.
    if (result.amountMinor !== obligation.advertiserTotalMinor) {
      return {
        ok: false,
        code: "AMOUNT_MISMATCH",
        reason: "Verified amount does not match the obligation total.",
      };
    }

    if (result.currency !== obligation.currency) {
      return {
        ok: false,
        code: "CURRENCY_MISMATCH",
        reason: "Verified currency does not match the obligation currency.",
      };
    }

    const transition = await transitionObligation({
      obligationId: obligation.id,
      from: "PROCESSING",
      to: "FUNDED",
      cause: "payment_verified",
      actor: "PROVIDER",
      actorId: null,
      source: "funding-verification",
      idempotencyKey: `evt:${obligation.id}:payment_verified`,
      providerReference,
      ledgerEntries: fundingLedgerEntries({
        advertiserId: obligation.advertiserId,
        creatorAmountMinor: obligation.creatorAmountMinor,
        platformFeeMinor: obligation.platformFeeMinor,
        advertiserTotalMinor: obligation.advertiserTotalMinor,
        currency: obligation.currency,
        providerReference,
      }),
    });

    if (!transition.ok) {
      // CONCURRENT_CONFLICT: another verification/webhook already moved it —
      // re-read and report idempotently. INVALID_TRANSITION: refused.
      const current = await prisma.financialObligation.findUnique({
        where: { id: obligation.id },
        select: { status: true },
      });

      if (current?.status === "FUNDED") {
        return {
          ok: true,
          obligationId: obligation.id,
          status: "FUNDED",
          idempotentReplay: true,
          providerReference,
        };
      }

      return {
        ok: false,
        code: "VERIFICATION_FAILED",
        reason: transition.reason,
      };
    }

    await recordAttemptStatus(obligation.id, providerReference, "SUCCEEDED", {
      verifiedAmountMinor: result.amountMinor.toString(),
      paidAt: result.paidAt,
    });

    return {
      ok: true,
      obligationId: obligation.id,
      status: "FUNDED",
      idempotentReplay: transition.idempotentReplay,
      providerReference,
    };
  }

  // --- Unverified paths. ---

  if (result.reason?.startsWith("provider_unavailable")) {
    // Timeout/network uncertainty: stay PROCESSING. Never FAILED.
    return {
      ok: false,
      code: "PROVIDER_UNAVAILABLE",
      reason: "The payment provider could not be reached — the payment stays pending verification.",
    };
  }

  const definitiveFailure =
    result.reason !== undefined &&
    /Paystack reports the transaction as (failed|abandoned|reverse|reversed)/i.test(result.reason);

  if (definitiveFailure) {
    const failTransition = await transitionObligation({
      obligationId: obligation.id,
      from: "PROCESSING",
      to: "FAILED",
      cause: "payment_failed",
      actor: "PROVIDER",
      actorId: null,
      source: "funding-verification",
      idempotencyKey: `evt:${obligation.id}:payment_failed`,
    });

    if (failTransition.ok || failTransition.code === "CONCURRENT_CONFLICT") {
      await recordAttemptStatus(obligation.id, providerReference, "FAILED");
    }

    if (failTransition.ok) {
      return {
        ok: true,
        obligationId: obligation.id,
        status: "FAILED",
        idempotentReplay: false,
        providerReference,
      };
    }

    const current = await prisma.financialObligation.findUnique({
      where: { id: obligation.id },
      select: { status: true },
    });

    if (current?.status === "FAILED") {
      return {
        ok: true,
        obligationId: obligation.id,
        status: "FAILED",
        idempotentReplay: true,
        providerReference,
      };
    }

    return {
      ok: false,
      code: "VERIFICATION_FAILED",
      reason: failTransition.reason,
    };
  }

  // Amount/currency mismatch or any other unverified reason: refuse, keep
  // PROCESSING, and surface an explicit code for the caller/audit.
  const isAmountMismatch = /amount/i.test(result.reason ?? "");
  const isCurrencyMismatch = /currency/i.test(result.reason ?? "");

  await recordAttemptStatus(obligation.id, providerReference, "PENDING", {
    lastUnverifiedReason: (result.reason ?? "unverified").slice(0, 300),
  });

  return {
    ok: false,
    code: isCurrencyMismatch
      ? "CURRENCY_MISMATCH"
      : isAmountMismatch
        ? "AMOUNT_MISMATCH"
        : "UNVERIFIED",
    reason:
      result.reason ??
      "The payment could not be verified — it stays pending until the provider confirms it.",
  };
}
