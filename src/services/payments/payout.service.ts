import "server-only";

import { prisma } from "@/lib/prisma";
import { getPaymentProvider } from "@/services/payments/index";
import { getActiveRecipientForCreator } from "@/services/payments/payout-recipient.service";

/**
 * Stage 14C — creator payout execution (the receivable → real money hop).
 *
 * LOGICAL PAYOUT vs PROVIDER ATTEMPT (the design the scope requires):
 *   - CreatorPayout is the LOGICAL payout: exactly one per milestone (unique
 *     milestoneId) with a deterministic payoutRef. It represents the claim
 *     created when the milestone settled;
 *   - PaymentProviderTransaction rows are the PROVIDER ATTEMPTS: each carries
 *     its own unique provider reference `mpayout:<milestoneId>:<n>` (n =
 *     attemptCount). A definitive failure NEVER reuses a reference — the next
 *     attempt gets n+1. The attempt row is the only place a Paystack
 *     transfer_code/access reference is stored.
 *
 * DISPUTE POLICY:
 *   - the obligation's dispute flag is re-read FRESH immediately before the
 *     provider call (the pre-transfer gate is inside the claim transaction);
 *   - once Paystack ACCEPTS a transfer, a later dispute cannot cancel it:
 *     from that point only provider evidence (getTransferStatus / transfer
 *     webhooks / reconciliation polling) settles the attempt — success,
 *     failed or REVERSED — and a reversal writes compensating ledger entries.
 *
 * MONEY DISCIPLINE:
 *   - the transfer amount is EXACTLY milestone.creatorAmountMinor — never
 *     advertiserTotalMinor, never any fee (fees were already credited to the
 *     platform at settlement);
 *   - "paid" is provider-confirmed only: transfer creation returning OK marks
 *     the attempt PENDING, never PAID. The receivable-clearing ledger entry
 *     (CREATOR_PAYOUT DEBIT creator receivable / CREDIT provider settlement)
 *     is written exactly once, on CONFIRMED success, guarded by the unique
 *     ledger idempotency key;
 *   - milestone/obligation settlement states are NEVER altered by payout
 *     execution — transfers ride ON TOP of settled milestones, preserving
 *     milestone independence and the single 13A state machine.
 */

export type PayoutErrorCode =
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "NOT_RELEASED"
  | "FUNDING_MISSING"
  | "DISPUTE_FROZEN"
  | "RECIPIENT_MISSING"
  | "RECIPIENT_MISMATCH"
  | "PROVIDER_UNCONFIGURED"
  | "PROVIDER_FAILED"
  | "PAYOUT_PENDING";

export type PayoutResult =
  | {
      ok: true;
      payoutId: string;
      payoutRef: string;
      status: "PENDING" | "PAID";
      attemptReference: string;
      attemptCount: number;
      /** True when an existing logical payout/attempt was reused. */
      idempotentReplay: boolean;
    }
  | { ok: false; code: PayoutErrorCode; reason: string };

/** Deterministic provider reference for attempt n of one logical payout. */
function attemptReference(payoutRef: string, attemptNumber: number): string {
  return `${payoutRef}:a${attemptNumber}`;
}

/** The deterministic logical payout reference for a milestone. */
export function logicalPayoutRef(milestoneId: string): string {
  return `mpo-${milestoneId}`;
}

/**
 * Initiate (or resume) the creator payout for one RELEASED milestone.
 *
 * System-triggered (called from the settlement paths / reconciliation) —
 * there is no creator "pay me" action: the creator's only financial role is
 * maintaining their server-owned recipient. Every authorization input comes
 * from the milestone/agreement relationships, never from a client.
 */
export async function initiateMilestonePayout(
  milestoneId: string,
  options: {
    /** Test seam ONLY: injects the provider (never exposed to actions). */
    providerOverride?: {
      createPayout: (request: {
        creatorId: string;
        amountMinor: bigint;
        currency: string;
        reference: string;
        recipientCode: string;
      }) => Promise<{ status: "pending" | "failed"; providerReference: string | null; reason?: string }>;
    };
  } = {},
): Promise<PayoutResult> {
  // ---- 1. Load the milestone with its settlement context. ----
  const milestone = await prisma.milestone.findUnique({
    where: { id: milestoneId },
    select: {
      id: true,
      milestoneRef: true,
      status: true,
      creatorId: true,
      creatorAmountMinor: true,
      currency: true,
      agreementId: true,
    },
  });

  if (!milestone) {
    return { ok: false, code: "NOT_FOUND", reason: "Milestone not found." };
  }

  // ---- 2. Settlement gates (all server-derived facts). ----
  if (milestone.status !== "RELEASED") {
    return {
      ok: false,
      code: "NOT_RELEASED",
      reason: "Payouts run only for released milestones.",
    };
  }

  const obligation = await prisma.financialObligation.findUnique({
    where: { agreementId: milestone.agreementId },
    select: {
      id: true,
      status: true,
      escrowFunded: true,
      dispute: true,
      disputeReason: true,
    },
  });

  if (!obligation) {
    return {
      ok: false,
      code: "FUNDING_MISSING",
      reason: "No financial obligation exists for this milestone's agreement.",
    };
  }

  if (!obligation.escrowFunded) {
    return {
      ok: false,
      code: "FUNDING_MISSING",
      reason: "The agreement's funding has not been provider-verified.",
    };
  }

  // Dispute gate (first read; re-checked fresh inside the claim below).
  if (obligation.dispute) {
    return {
      ok: false,
      code: "DISPUTE_FROZEN",
      reason: "The funds are under a dispute freeze; payouts are blocked.",
    };
  }

  if (!["FUNDED", "SETTLEMENT_PENDING", "RELEASED"].includes(obligation.status)) {
    return {
      ok: false,
      code: "INVALID_STATE",
      reason: `The obligation is ${obligation.status} — it cannot fund payouts.`,
    };
  }

  // ---- 3. Recipient: resolved ONLY from server-owned storage. ----
  const recipient = await getActiveRecipientForCreator(milestone.creatorId, milestone.currency);

  if (!recipient) {
    return {
      ok: false,
      code: "RECIPIENT_MISSING",
      reason: "The creator has no payout destination on file yet.",
    };
  }

  if (recipient.creatorId !== milestone.creatorId) {
    // Defense in depth: the storage query already filters by creatorId.
    return {
      ok: false,
      code: "RECIPIENT_MISMATCH",
      reason: "The payout destination does not belong to this milestone's creator.",
    };
  }

  // ---- 4. Claim/create the LOGICAL payout (unique milestoneId arbitrates). ----
  const payoutRef = logicalPayoutRef(milestoneId);

  const payout = await upsertLogicalPayout({
    milestoneId,
    payoutRef,
    agreementId: milestone.agreementId,
    obligationId: obligation.id,
    creatorId: milestone.creatorId,
    amountMinor: milestone.creatorAmountMinor,
    currency: milestone.currency,
  });

  // Idempotent replay of an already-PAID logical payout.
  if (payout.status === "PAID") {
    return {
      ok: true,
      payoutId: payout.id,
      payoutRef: payout.payoutRef,
      status: "PAID",
      attemptReference: payout.lastProviderReference ?? "",
      attemptCount: payout.attemptCount,
      idempotentReplay: true,
    };
  }

  // ---- 5. DISPUTE RACE re-check + attempt claim, atomically. ----
  // The logical payout row's conditional update doubles as the concurrency
  // claim: only one caller may move PENDING/PROCESSING → PROCESSING with a
  // given attempt number, and the dispute flag is re-read INSIDE the same
  // transaction so a freeze engaging concurrently is seen before any call.
  type ClaimResult =
    | { kind: "refused"; code: "DISPUTE_FROZEN" | "NOT_FOUND" }
    | { kind: "replay"; attemptReference: string; attemptCount: number }
    | { kind: "inFlight"; attemptReference: string; attemptCount: number }
    | { kind: "claimed"; attemptNumber: number; attemptReference: string };

  const claim: ClaimResult = await prisma.$transaction(async (tx): Promise<ClaimResult> => {
    const freshObligation = await tx.financialObligation.findUnique({
      where: { id: obligation.id },
      select: { dispute: true },
    });

    if (freshObligation?.dispute) {
      return { kind: "refused", code: "DISPUTE_FROZEN" };
    }

    const fresh = await tx.creatorPayout.findUnique({
      where: { id: payout.id },
      select: { status: true, attemptCount: true, lastProviderReference: true },
    });

    if (!fresh) {
      return { kind: "refused", code: "NOT_FOUND" };
    }

    if (fresh.status === "PAID") {
      return {
        kind: "replay",
        attemptReference: fresh.lastProviderReference ?? "",
        attemptCount: fresh.attemptCount,
      };
    }

    if (fresh.status === "PROCESSING") {
      // Another worker's attempt is in flight — never a second transfer.
      return {
        kind: "inFlight",
        attemptReference: fresh.lastProviderReference ?? "",
        attemptCount: fresh.attemptCount,
      };
    }

    const nextAttempt = fresh.attemptCount + 1;

    const updated = await tx.creatorPayout.updateMany({
      where: { id: payout.id, status: { in: ["PENDING", "FAILED"] }, attemptCount: fresh.attemptCount },
      data: {
        status: "PROCESSING",
        attemptCount: nextAttempt,
        lastProviderReference: attemptReference(payoutRef, nextAttempt),
        failedAt: null,
      },
    });

    if (updated.count === 0) {
      // Lost a race — re-read and report honestly.
      const current = await tx.creatorPayout.findUnique({
        where: { id: payout.id },
        select: { status: true, attemptCount: true, lastProviderReference: true },
      });

      return {
        kind: "inFlight",
        attemptReference: current?.lastProviderReference ?? "",
        attemptCount: current?.attemptCount ?? 0,
      };
    }

    return {
      kind: "claimed",
      attemptNumber: nextAttempt,
      attemptReference: attemptReference(payoutRef, nextAttempt),
    };
  });

  if (claim.kind === "refused") {
    return {
      ok: false,
      code: claim.code,
      reason:
        claim.code === "DISPUTE_FROZEN"
          ? "The funds came under a dispute freeze before the transfer — payout blocked."
          : "Payout not found.",
    };
  }

  if (claim.kind === "replay") {
    return {
      ok: true,
      payoutId: payout.id,
      payoutRef: payout.payoutRef,
      status: "PAID",
      attemptReference: claim.attemptReference,
      attemptCount: claim.attemptCount,
      idempotentReplay: true,
    };
  }

  if (claim.kind === "inFlight") {
    return {
      ok: true,
      payoutId: payout.id,
      payoutRef: payout.payoutRef,
      status: "PENDING",
      attemptReference: claim.attemptReference,
      attemptCount: claim.attemptCount,
      idempotentReplay: true,
    };
  }

  const { attemptNumber, attemptReference: providerReference } = claim;

  // ---- 6. Record the provider ATTEMPT before calling the provider. ----
  // The attempt row exists (PENDING) BEFORE the transfer call, so a crash
  // after a provider-side acceptance is recoverable by status polling.
  try {
    await prisma.paymentProviderTransaction.create({
      data: {
        obligationId: obligation.id,
        milestoneId,
        provider: "paystack",
        providerReference,
        providerStatus: "PENDING",
        amountMinor: milestone.creatorAmountMinor,
        currency: milestone.currency,
        metadata: {
          kind: "creator_payout",
          payoutRef,
          attemptNumber,
          recipientCode: recipient.recipientCode,
        },
      },
    });
  } catch (error) {
    // Unique race: a concurrent worker created this attempt first — treat as
    // in-flight. Any other failure: release the claim (back to FAILED/PENDING
    // semantics) and report; reconciliation converges.
    const isUniqueViolation =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2002";

    if (!isUniqueViolation) {
      console.error("paymentProviderTransaction.create (payout) failed", error);

      await prisma.creatorPayout.updateMany({
        where: { id: payout.id, status: "PROCESSING", attemptCount: attemptNumber },
        data: { status: "PENDING", lastProviderReference: null },
      });

      return {
        ok: false,
        code: "PROVIDER_FAILED",
        reason: "The payout attempt could not be recorded — it was not started.",
      };
    }

    return {
      ok: true,
      payoutId: payout.id,
      payoutRef: payout.payoutRef,
      status: "PENDING",
      attemptReference: providerReference,
      attemptCount: attemptNumber,
      idempotentReplay: true,
    };
  }

  // ---- 7. Call the provider (amount = frozen creator amount ONLY). ----
  const provider =
    options.providerOverride ??
    (() => {
      try {
        return getPaymentProvider();
      } catch {
        return null;
      }
    })();

  if (!provider) {
    // Release the claim — nothing was started provider-side.
    await releaseClaim(payout.id, attemptNumber);

    return {
      ok: false,
      code: "PROVIDER_UNCONFIGURED",
      reason: "No payment provider is configured yet.",
    };
  }

  const transfer = await provider.createPayout({
    creatorId: milestone.creatorId,
    amountMinor: milestone.creatorAmountMinor,
    currency: milestone.currency,
    reference: providerReference,
    recipientCode: recipient.recipientCode,
  });

  if (transfer.status === "failed") {
    // Definitive provider rejection: mark THIS attempt FAILED; the logical
    // payout returns to FAILED (receivable open); the next retry gets a NEW
    // reference (attemptCount incremented). The milestone stays RELEASED.
    await prisma.paymentProviderTransaction.updateMany({
      where: { providerReference, provider: "paystack" },
      data: { providerStatus: "FAILED", confirmedAt: new Date() },
    });

    await prisma.creatorPayout.updateMany({
      where: { id: payout.id, status: "PROCESSING", attemptCount: attemptNumber },
      data: { status: "FAILED", failedAt: new Date() },
    });

    await prisma.financialEvent
      .create({
        data: {
          obligationId: obligation.id,
          agreementId: milestone.agreementId,
          eventType: "payout_failed",
          actor: "PROVIDER",
          source: "payout-service",
          metadata: {
            payoutRef,
            attemptReference: providerReference,
            attemptNumber,
            amountMinor: milestone.creatorAmountMinor.toString(),
            reason: (transfer.reason ?? "").slice(0, 300),
          },
          idempotencyKey: `evt:${providerReference}:payout_failed`,
        },
      })
      .catch(() => undefined);

    return {
      ok: false,
      code: "PROVIDER_FAILED",
      reason: transfer.reason ?? "The provider rejected the transfer.",
    };
  }

  // Accepted (pending): Paystack transfers are ASYNCHRONOUS — the attempt
  // stays PENDING and the creator is NOT marked paid. Settlement states are
  // untouched. Confirmation arrives via getTransferStatus polling or
  // transfer webhooks; the ledger clearing entry is written ONLY then.
  await prisma.paymentProviderTransaction.updateMany({
    where: { providerReference, provider: "paystack" },
    data: { providerStatus: "PENDING" },
  });

  return {
    ok: true,
    payoutId: payout.id,
    payoutRef: payout.payoutRef,
    status: "PENDING",
    attemptReference: providerReference,
    attemptCount: attemptNumber,
    idempotentReplay: false,
  };
}

/** Release an in-flight claim back to PENDING after a pre-provider failure. */
async function releaseClaim(payoutId: string, attemptNumber: number): Promise<void> {
  await prisma.creatorPayout.updateMany({
    where: { id: payoutId, status: "PROCESSING", attemptCount: attemptNumber },
    data: { status: "PENDING" },
  });
}

/**
 * Create the logical payout row, or fetch the existing one. The unique
 * milestoneId is the arbiter — concurrent first calls converge.
 */
async function upsertLogicalPayout(input: {
  milestoneId: string;
  payoutRef: string;
  agreementId: string;
  obligationId: string;
  creatorId: string;
  amountMinor: bigint;
  currency: string;
}): Promise<{
  id: string;
  status: string;
  attemptCount: number;
  lastProviderReference: string | null;
  payoutRef: string;
}> {
  const existing = await prisma.creatorPayout.findUnique({
    where: { milestoneId: input.milestoneId },
  });

  if (existing) {
    return existing;
  }

  try {
    return await prisma.creatorPayout.create({
      data: {
        milestoneId: input.milestoneId,
        agreementId: input.agreementId,
        obligationId: input.obligationId,
        creatorId: input.creatorId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        payoutRef: input.payoutRef,
        status: "PENDING",
      },
    });
  } catch (error) {
    const isUniqueViolation =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2002";

    if (!isUniqueViolation) {
      throw error;
    }

    const raced = await prisma.creatorPayout.findUnique({
      where: { milestoneId: input.milestoneId },
    });

    if (!raced) {
      throw error;
    }

    return raced;
  }
}

/**
 * Confirm a provider transfer outcome (from status polling or a transfer
 * webhook) and settle the attempt with EVIDENCE, never payload trust:
 *
 *   - success  → attempt SUCCEEDED, logical payout PAID, receivable-clearing
 *                ledger written EXACTLY ONCE (unique idempotency key),
 *                payout_completed event;
 *   - failed   → attempt FAILED, logical payout FAILED (receivable open,
 *                milestone untouched), payout_failed event;
 *   - reversed → compensating ledger entries (append-only), receivable
 *                re-opens, payout_reversed event, logical payout marked
 *                REVERSAL_RECEIVED;
 *   - pending  → nothing changes (never auto-retry).
 */
export async function settlePayoutFromProviderEvidence(
  providerReference: string,
  outcome: "success" | "failed" | "reversed" | "pending",
): Promise<{ ok: boolean; note: string }> {
  const attempt = await prisma.paymentProviderTransaction.findUnique({
    where: { provider_providerReference: { provider: "paystack", providerReference } },
  });

  if (!attempt || attempt.milestoneId === null) {
    // Unknown reference: never mutate anything.
    return { ok: false, note: "No payout attempt matches this reference." };
  }

  // Idempotency guard: replays of the SAME outcome are no-ops — but a
  // REVERSAL is a NEW definitive outcome that may legitimately follow a
  // SUCCEEDED attempt (the provider clawed the transfer back), so it is
  // allowed to proceed from SUCCEEDED.
  const alreadySettled =
    attempt.providerStatus === "SUCCEEDED" ||
    attempt.providerStatus === "FAILED" ||
    attempt.providerStatus === "REVERSED";

  if (alreadySettled && !(outcome === "reversed" && attempt.providerStatus === "SUCCEEDED")) {
    return { ok: true, note: `Attempt already settled (${attempt.providerStatus}).` };
  }

  const payout = await prisma.creatorPayout.findUnique({
    where: { milestoneId: attempt.milestoneId },
  });

  if (!payout) {
    return { ok: false, note: "No logical payout exists for this attempt." };
  }

  const milestone = await prisma.milestone.findUnique({
    where: { id: attempt.milestoneId },
    select: { creatorId: true, creatorAmountMinor: true, currency: true, agreementId: true },
  });

  if (!milestone) {
    return { ok: false, note: "Milestone no longer exists." };
  }

  // Defense in depth: the settled amount must be the frozen creator amount.
  if (attempt.amountMinor !== milestone.creatorAmountMinor) {
    return { ok: false, note: "Attempt amount does not match the frozen milestone amount — refusing to settle." };
  }

  if (outcome === "pending") {
    return { ok: true, note: "Transfer still pending — no state change." };
  }

  if (outcome === "success") {
    const alreadyPaid = payout.status === "PAID";

    // 1. Clearing ledger — exactly once, guarded by the unique key.
    await prisma.ledgerEntry
      .create({
        data: {
          account: `creator:${milestone.creatorId}:receivable`,
          direction: "DEBIT",
          amountMinor: milestone.creatorAmountMinor,
          currency: milestone.currency,
          entryType: "CREATOR_PAYOUT",
          agreementId: milestone.agreementId,
          financialObligationId: attempt.obligationId,
          providerReference,
          idempotencyKey: `mpaid:${providerReference}`,
          metadata: { kind: "payout_cleared", payoutRef: payout.payoutRef },
        },
      })
      .catch(() => undefined); // duplicate key = already cleared (replay)

    await prisma.ledgerEntry
      .create({
        data: {
          account: "provider:paystack:settlement",
          direction: "CREDIT",
          amountMinor: milestone.creatorAmountMinor,
          currency: milestone.currency,
          entryType: "CREATOR_PAYOUT",
          agreementId: milestone.agreementId,
          financialObligationId: attempt.obligationId,
          providerReference,
          idempotencyKey: `mpaid:${providerReference}:settlement`,
          metadata: { kind: "payout_settlement", payoutRef: payout.payoutRef },
        },
      })
      .catch(() => undefined);

    // 2. Attempt + logical payout statuses (conditional, idempotent).
    await prisma.paymentProviderTransaction.updateMany({
      where: { providerReference, provider: "paystack", providerStatus: { in: ["PENDING", "REQUIRES_ACTION"] } },
      data: { providerStatus: "SUCCEEDED", confirmedAt: new Date() },
    });

    const updated = await prisma.creatorPayout.updateMany({
      where: { id: payout.id, status: { in: ["PENDING", "PROCESSING", "FAILED"] } },
      data: { status: "PAID", paidAt: new Date() },
    });

    // 3. Audit event.
    await prisma.financialEvent
      .create({
        data: {
          obligationId: attempt.obligationId,
          agreementId: milestone.agreementId,
          eventType: "payout_completed",
          actor: "PROVIDER",
          source: "payout-service",
          metadata: {
            payoutRef: payout.payoutRef,
            attemptReference: providerReference,
            amountMinor: milestone.creatorAmountMinor.toString(),
          },
          idempotencyKey: `evt:${providerReference}:payout_completed`,
        },
      })
      .catch(() => undefined);

    return {
      ok: true,
      note: alreadyPaid && updated.count === 0 ? "Payout already PAID (replay)." : "Payout confirmed and receivable cleared.",
    };
  }

  if (outcome === "failed") {
    await prisma.paymentProviderTransaction.updateMany({
      where: { providerReference, provider: "paystack", providerStatus: { in: ["PENDING", "REQUIRES_ACTION"] } },
      data: { providerStatus: "FAILED", confirmedAt: new Date() },
    });

    await prisma.creatorPayout.updateMany({
      where: { id: payout.id, status: "PROCESSING" },
      data: { status: "FAILED", failedAt: new Date() },
    });

    await prisma.financialEvent
      .create({
        data: {
          obligationId: attempt.obligationId,
          agreementId: milestone.agreementId,
          eventType: "payout_failed",
          actor: "PROVIDER",
          source: "payout-service",
          metadata: {
            payoutRef: payout.payoutRef,
            attemptReference: providerReference,
            amountMinor: milestone.creatorAmountMinor.toString(),
          },
          idempotencyKey: `evt:${providerReference}:payout_failed`,
        },
      })
      .catch(() => undefined);

    // The receivable stays open; the milestone stays RELEASED.
    return { ok: true, note: "Transfer definitively failed — receivable remains open for retry." };
  }

  // --- reversed ---
  // Compensating entries, append-only: re-credit the receivable, re-debit the
  // settlement account. Never delete or rewrite history.
  await prisma.ledgerEntry
    .create({
      data: {
        account: "provider:paystack:settlement",
        direction: "DEBIT",
        amountMinor: milestone.creatorAmountMinor,
        currency: milestone.currency,
        entryType: "CREATOR_PAYOUT",
        agreementId: milestone.agreementId,
        financialObligationId: attempt.obligationId,
        providerReference,
        idempotencyKey: `mrev:${providerReference}:settlement`,
        metadata: { kind: "payout_reversal", payoutRef: payout.payoutRef },
      },
    })
    .catch(() => undefined);

  await prisma.ledgerEntry
    .create({
      data: {
        account: `creator:${milestone.creatorId}:receivable`,
        direction: "CREDIT",
        amountMinor: milestone.creatorAmountMinor,
        currency: milestone.currency,
        entryType: "CREATOR_PAYOUT",
        agreementId: milestone.agreementId,
        financialObligationId: attempt.obligationId,
        providerReference,
        idempotencyKey: `mrev:${providerReference}:receivable`,
        metadata: { kind: "payout_reversal", payoutRef: payout.payoutRef },
      },
    })
    .catch(() => undefined);

  await prisma.paymentProviderTransaction.updateMany({
    where: { providerReference, provider: "paystack", providerStatus: { in: ["PENDING", "REQUIRES_ACTION", "SUCCEEDED"] } },
    data: { providerStatus: "REVERSED", confirmedAt: new Date() },
  });

  await prisma.creatorPayout.updateMany({
    where: { id: payout.id, status: { in: ["PAID", "PROCESSING", "PENDING"] } },
    data: { status: "REVERSAL_RECEIVED", reversedAt: new Date() },
  });

  await prisma.financialEvent
    .create({
      data: {
        obligationId: attempt.obligationId,
        agreementId: milestone.agreementId,
        eventType: "payout_reversed",
        actor: "PROVIDER",
        source: "payout-service",
        metadata: {
          payoutRef: payout.payoutRef,
          attemptReference: providerReference,
          amountMinor: milestone.creatorAmountMinor.toString(),
        },
        idempotencyKey: `evt:${providerReference}:payout_reversed`,
      },
    })
    .catch(() => undefined);

  return { ok: true, note: "Reversal received — compensating entries written and the receivable re-opened." };
}

/**
 * Reconciliation hook: poll every in-flight payout attempt through the
 * provider and settle on definitive evidence. Timeout/unknown NEVER retries
 * the transfer and NEVER fails the attempt.
 */
export async function pollPendingPayouts(options: {
  providerOverride?: {
    getTransferStatus: (request: { providerReference: string }) => Promise<{
      status: "pending" | "success" | "failed" | "reversed" | "unknown";
      providerReference: string;
    }>;
  };
  now?: Date;
  thresholdMinutes?: number;
} = {}): Promise<{ polled: number; settled: number; notes: string[] }> {
  const thresholdMinutes = options.thresholdMinutes ?? 30;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - thresholdMinutes * 60 * 1000);

  const inFlight = await prisma.paymentProviderTransaction.findMany({
    where: {
      milestoneId: { not: null },
      providerStatus: { in: ["PENDING", "REQUIRES_ACTION"] },
      initiatedAt: { lt: cutoff },
    },
    select: { providerReference: true },
    take: 100,
  });

  const notes: string[] = [];
  let settled = 0;

  let provider = options.providerOverride;

  if (!provider) {
    try {
      const real = getPaymentProvider();

      provider = {
        getTransferStatus: async (request: { providerReference: string }) => {
          const result = await real.getTransferStatus(request);

          return "providerReference" in result
            ? result
            : { status: "unknown" as const, providerReference: request.providerReference };
        },
      };
    } catch {
      return { polled: 0, settled: 0, notes: ["No payment provider configured — nothing polled."] };
    }
  }

  for (const attempt of inFlight) {
    const status = await provider.getTransferStatus({
      providerReference: attempt.providerReference,
    });

    if (status.status === "unknown") {
      notes.push(`${attempt.providerReference}: provider unavailable — stays pending.`);
      continue;
    }

    const result = await settlePayoutFromProviderEvidence(attempt.providerReference, status.status);

    notes.push(`${attempt.providerReference}: ${result.note}`);

    if (status.status !== "pending") {
      settled += 1;
    }
  }

  return { polled: inFlight.length, settled, notes };
}

/**
 * Catch-up: ensure every RELEASED milestone has its logical payout attempt
 * started (used by reconciliation so a crash between settlement and payout
 * initiation cannot strand a payable creator).
 */
export async function ensurePayoutsStartedForReleasedMilestones(): Promise<{ started: number; blocked: number }> {
  const released = await prisma.milestone.findMany({
    where: { status: "RELEASED", payout: null },
    select: { id: true },
    take: 50,
  });

  let started = 0;
  let blocked = 0;

  for (const milestone of released) {
    const result = await initiateMilestonePayout(milestone.id);

    if (result.ok || result.code === "RECIPIENT_MISSING" || result.code === "DISPUTE_FROZEN") {
      // Recipient-missing / dispute-frozen create the logical row only via
      // initiation; count them as blocked, not failed.
      started += result.ok ? 1 : 0;
      blocked += result.ok ? 0 : 1;
    } else {
      blocked += 1;
    }
  }

  return { started, blocked };
}
