import "server-only";

import { prisma } from "@/lib/prisma";
import { getPaymentProvider } from "@/services/payments/index";
import { transitionObligation } from "@/services/payments/obligation-state.service";

/**
 * Stage 14B — payment initiation (the PENDING_PAYMENT → PROCESSING seam).
 *
 * What this service is responsible for:
 *   1. authorize (advertiser-owned obligation, authoritative amounts);
 *   2. enforce ONE charge attempt per obligation (duplicate/concurrent
 *      initiation converges on the existing attempt — the unique
 *      (provider, providerReference) constraint on PaymentProviderTransaction
 *      and the obligation's conditional status update are the arbiters);
 *   3. call the provider through the Stage 13A port with amounts taken
 *      EXCLUSIVELY from the frozen obligation (advertiserTotalMinor);
 *   4. record the attempt in PaymentProviderTransaction and drive
 *      PENDING_PAYMENT → PROCESSING with NO ledger lines (a click/initiation
 *      never records money as paid — 13A invariant).
 *
 * What the client may supply: the obligation id. Nothing else. Amount,
 * currency, providerReference and target status are always server-derived.
 *
 * Crash-safety (initiation succeeded provider-side but local DB work failed):
 * the provider charge is keyed by the obligation's deterministic reference, so
 * a retried initiation after a crash does NOT create a second Paystack charge
 * with the same reference — Paystack rejects duplicated references. The
 * service re-checks the obligation state first and, if the charge call itself
 * succeeds but the row write fails, the next call finds status PROCESSING
 * (transition won) or re-derives the charge with the same reference and
 * converges. No second financial state machine anywhere: the 13A executor
 * remains the only status writer.
 */

export type InitiationErrorCode =
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "INVALID_STATE"
  | "EMAIL_MISSING"
  | "PROVIDER_UNCONFIGURED"
  | "PROVIDER_FAILED"
  | "INITIATION_FAILED";

export type InitiatePaymentResult =
  | {
      ok: true;
      obligationId: string;
      obligationRef: string;
      /** Deterministic Paystack reference === obligationRef. */
      paymentReference: string;
      amountMinor: bigint;
      currency: string;
      redirectUrl: string;
      providerReference: string;
      /** True when an existing attempt was returned instead of a new charge. */
      idempotentReplay: boolean;
    }
  | { ok: false; code: InitiationErrorCode; reason: string };

/** Advertiser-owned obligation read with ownership INSIDE the query. */
async function loadOwnedObligation(
  obligationId: string,
  advertiserProfileId: string,
) {
  return prisma.financialObligation.findFirst({
    where: { id: obligationId, advertiserId: advertiserProfileId },
    select: {
      id: true,
      agreementId: true,
      campaignId: true,
      advertiserId: true,
      creatorId: true,
      obligationRef: true,
      status: true,
      advertiserTotalMinor: true,
      currency: true,
      providerReference: true,
    },
  });
}

/**
 * Initiate the Paystack charge for one advertiser-owned obligation.
 *
 * Flow:
 *   1. Load + authorize (fail closed: foreign/unknown id → NOT_FOUND).
 *   2. FUNDED/SETTLEMENT_PENDING etc. → INVALID_STATE (already paid).
 *      PROCESSING with an existing attempt → return that attempt (idempotent).
 *      PROCESSING without a recorded attempt (crash window) → fall through to
 *      re-derive the charge with the SAME deterministic reference.
 *   3. Transition PENDING_PAYMENT → PROCESSING FIRST (conditional update —
 *      the state machine arbitrates concurrent initiations; ledger untouched).
 *   4. Call the provider. On failure → transition PROCESSING → FAILED
 *      (definitive, provider-reported) so the obligation is never stuck.
 *   5. Record the PaymentProviderTransaction attempt (unique reference).
 */
export async function initiatePaymentForObligation(
  obligationId: string,
  advertiserProfileId: string,
  /**
   * Test seam ONLY (never exposed to actions): injects the provider so tests
   * can simulate Paystack without network. Production passes nothing.
   */
  providerOverride?: Pick<
    import("@/services/payments/index").PaymentProvider,
    "createCharge"
  >,
): Promise<InitiatePaymentResult> {
  // ---- 1. Load + authorize (fail closed). ----
  const obligation = await loadOwnedObligation(obligationId, advertiserProfileId);

  if (!obligation) {
    return {
      ok: false,
      code: "NOT_FOUND",
      reason:
        "This payment does not exist, is not yours, or can no longer be initiated.",
    };
  }

  // ---- 2. State/idempotency gate. ----
  if (obligation.status === "PROCESSING") {
    const existing = await prisma.paymentProviderTransaction.findFirst({
      where: { obligationId: obligation.id },
      orderBy: { initiatedAt: "desc" },
    });

    if (existing) {
      // A previous initiation already happened — return it. Never a second
      // Paystack charge for the same deterministic reference.
      if (existing.providerStatus === "PENDING" || existing.providerStatus === "REQUIRES_ACTION") {
        return {
          ok: true,
          obligationId: obligation.id,
          obligationRef: obligation.obligationRef,
          paymentReference: obligation.obligationRef,
          amountMinor: obligation.advertiserTotalMinor,
          currency: obligation.currency,
          // redirectUrl is NOT persisted (secret-free audit rows only); the
          // advertiser simply re-opens the (still valid) hosted page via the
          // same access code captured on the attempt row's providerReference.
          redirectUrl: existing.metadata && typeof (existing.metadata as { redirectUrl?: unknown }).redirectUrl === "string"
            ? ((existing.metadata as { redirectUrl: string }).redirectUrl)
            : "",
          providerReference: existing.providerReference,
          idempotentReplay: true,
        };
      }
    }

    // PROCESSING without a recorded attempt: a crash between the state
    // transition and the row write. Fall through and re-derive the charge
    // with the SAME obligation reference — Paystack refuses a duplicated
    // reference, so no double charge can be created.
  } else if (obligation.status !== "PENDING_PAYMENT") {
    // FUNDED and beyond (or FAILED/CANCELLED) — refuse definitively.
    return {
      ok: false,
      code: "INVALID_STATE",
      reason:
        obligation.status === "FUNDED" || obligation.status === "SETTLEMENT_PENDING"
          ? "This agreement is already funded — no new payment is needed."
          : "This payment can no longer be initiated in its current state.",
    };
  }

  // ---- 3. Claim the PENDING_PAYMENT → PROCESSING edge. ----
  if (obligation.status === "PENDING_PAYMENT") {
    const transition = await transitionObligation({
      obligationId: obligation.id,
      from: "PENDING_PAYMENT",
      to: "PROCESSING",
      cause: "payment_initiated",
      actor: "ADVERTISER",
      actorId: advertiserProfileId,
      source: "payment-initiation",
      idempotencyKey: `evt:${obligation.id}:payment_initiated`,
    });

    if (!transition.ok && transition.code !== "CONCURRENT_CONFLICT") {
      return {
        ok: false,
        code: "INVALID_STATE",
        reason: transition.reason,
      };
    }

    if (transition.ok && !transition.idempotentReplay) {
      // We won the edge. A concurrent sibling either loses the conditional
      // update (sees PROCESSING → idempotent path above on its next call) or
      // hits the unique attempt row below.
    }
  }

  // ---- 4. Call the provider (amounts from the frozen obligation ONLY). ----
  const provider =
    providerOverride ??
    (() => {
      try {
        return getPaymentProvider();
      } catch {
        return null;
      }
    })();

  if (!provider) {
    return {
      ok: false,
      code: "PROVIDER_UNCONFIGURED",
      reason: "No payment provider is configured yet.",
    };
  }

  const charge = await provider.createCharge({
    advertiserId: obligation.advertiserId,
    campaignId: obligation.campaignId,
    amountMinor: obligation.advertiserTotalMinor,
    currency: obligation.currency,
    reference: obligation.obligationRef,
  });

  if (charge.status === "failed") {
    // Definitive provider-reported failure → PROCESSING → FAILED so the
    // obligation is never stuck. (Timeouts during initialization are mapped
    // to failed BY THE ADAPTER because no charge exists provider-side; the
    // VERIFICATION timeout stays uncertainty — see verifyAndSettleFunding.)
    const failTransition = await transitionObligation({
      obligationId: obligation.id,
      from: "PROCESSING",
      to: "FAILED",
      cause: "payment_failed",
      actor: "PROVIDER",
      actorId: null,
      source: "payment-initiation",
      idempotencyKey: `evt:${obligation.id}:payment_failed:init`,
    });

    if (!failTransition.ok) {
      // A concurrent path already resolved the obligation — surface its
      // state honestly instead of failing silently.
      return {
        ok: false,
        code: "INVALID_STATE",
        reason: "The payment attempt could not be recorded as failed — its state changed concurrently. Re-check the payment status.",
      };
    }

    return {
      ok: false,
      code: "PROVIDER_FAILED",
      reason: charge.reason,
    };
  }

  // ---- 5. Record the attempt (unique (provider, providerReference)). ----
  try {
    await prisma.paymentProviderTransaction.create({
      data: {
        obligationId: obligation.id,
        provider: "paystack",
        // The access_code identifies the hosted charge; the deterministic
        // business reference stays the obligationRef (sent to Paystack).
        providerReference: charge.providerReference,
        providerStatus: charge.status === "succeeded" ? "SUCCEEDED" : "REQUIRES_ACTION",
        amountMinor: obligation.advertiserTotalMinor,
        currency: obligation.currency,
        metadata: {
          businessReference: obligation.obligationRef,
          redirectUrl: charge.status === "requires_action" ? charge.redirectUrl : null,
        },
      },
    });
  } catch (error) {
    // Unique race on (provider, providerReference): a concurrent initiation
    // wrote the attempt first. If it is ours (same access code), converge
    // idempotently; otherwise surface the conflict honestly.
    const isUniqueViolation =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2002";

    if (!isUniqueViolation) {
      // DB outage AFTER a successful provider charge: the obligation stays
      // PROCESSING (never falsely FAILED), the hosted charge remains valid
      // and payable, and reconciliation/webhooks will still settle it. The
      // advertiser's next initiation call hits the idempotent PROCESSING path
      // — Paystack refuses the duplicated deterministic reference, so no
      // second charge is ever created.
      console.error("paymentProviderTransaction.create failed after charge", error);

      return {
        ok: true,
        obligationId: obligation.id,
        obligationRef: obligation.obligationRef,
        paymentReference: obligation.obligationRef,
        amountMinor: obligation.advertiserTotalMinor,
        currency: obligation.currency,
        redirectUrl: charge.status === "requires_action" ? charge.redirectUrl : "",
        providerReference: charge.providerReference,
        idempotentReplay: false,
      };
    }

    const winner = await prisma.paymentProviderTransaction.findFirst({
      where: { obligationId: obligation.id },
      orderBy: { initiatedAt: "desc" },
    });

    if (winner && winner.providerReference === charge.providerReference) {
      return {
        ok: true,
        obligationId: obligation.id,
        obligationRef: obligation.obligationRef,
        paymentReference: obligation.obligationRef,
        amountMinor: obligation.advertiserTotalMinor,
        currency: obligation.currency,
        redirectUrl: charge.status === "requires_action" ? charge.redirectUrl : "",
        providerReference: winner.providerReference,
        idempotentReplay: true,
      };
    }

    return {
      ok: false,
      code: "INITIATION_FAILED",
      reason: "A concurrent payment attempt was recorded — re-check the payment status.",
    };
  }

  return {
    ok: true,
    obligationId: obligation.id,
    obligationRef: obligation.obligationRef,
    paymentReference: obligation.obligationRef,
    amountMinor: obligation.advertiserTotalMinor,
    currency: obligation.currency,
    redirectUrl: charge.status === "requires_action" ? charge.redirectUrl : "",
    providerReference: charge.providerReference,
    idempotentReplay: false,
  };
}
