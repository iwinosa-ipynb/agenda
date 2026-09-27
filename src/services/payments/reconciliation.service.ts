import "server-only";

import { prisma } from "@/lib/prisma";

import { verifyAndSettleFunding } from "@/services/payments/funding-verification.service";

/**
 * Funding reconciliation (Stage 13A boundary, completed in the Stage 14B
 * follow-up): a scheduled boundary that finds obligations stuck in an
 * intermediate state (PROCESSING) and actively re-verifies them through the
 * EXISTING server-side funding verification gate.
 *
 * What this worker does for each stuck PROCESSING obligation:
 *   1. Recovers the provider attempt ALREADY associated with the obligation
 *      (PaymentProviderTransaction). An obligation with no recorded attempt
 *      has nothing verifiable provider-side — it is reported, never invented
 *      (no verification call without a reference, no second attempt row);
 *   2. Skips obligations whose latest attempt is already definitively FAILED:
 *      the only PROCESSING → FAILED edge is provider verification evidence
 *      (funding-verification / payment-initiation), and staleness is never
 *      evidence of failure — so the worker does not invent one;
 *   3. Calls verifyAndSettleFunding(obligationId) — the untouched 14B gate:
 *      server-side Paystack verification against the frozen obligation
 *      (amount AND currency re-checked), idempotent by state machine +
 *      unique event/ledger keys.
 *
 * Critical semantics (unchanged):
 *   - A timeout is NOT evidence of payment failure. The worker never moves an
 *     obligation to FAILED on its own — stale PROCESSING that the provider
 *     still reports as pending/unverifiable simply stays PROCESSING for the
 *     next scan or a webhook.
 *   - The payload/report surface remains read-only for operators; the ONLY
 *     state changes come from verifyAndSettleFunding's own safe transitions.
 *
 * Idempotency & concurrency: verifyAndSettleFunding re-checks the obligation
 * state before any provider call (already-FUNDED/FAILED are no-op replays)
 * and its FUNDED transition is a conditional update with a unique event key
 * and per-line ledger keys — so repeated or concurrent scans can never
 * double-settle, double-write ledger entries, or duplicate financial events.
 * No new charge is ever initiated and no second provider reference is created.
 */

export type StuckObligation = {
  obligationId: string;
  obligationRef: string;
  status: string;
  currency: string;
  stuckSince: Date;
  ageMinutes: number;
  /** Present when a provider charge attempt was recorded for this obligation. */
  providerReference: string | null;
  providerTransactionStatus: string | null;
};

export type ReconciliationReport = {
  scannedAt: Date;
  stuckCount: number;
  candidates: StuckObligation[];
  /**
   * True only when at least one candidate's funding verification actually
   * reached the payment provider this scan — i.e. a verification result
   * (or a downstream refusal like AMOUNT_MISMATCH) decided the outcome.
   * False when no candidate was eligible, when the gate refused before any
   * provider contact (no provider configured, obligation not found or no
   * longer PROCESSING, pre-provider idempotent replay), or when the gate
   * threw an infrastructure error whose timing relative to the provider
   * call is unknown.
   */
  providerChecksPerformed: boolean;
  note: string;
  /** Stage 14C — payout-attempt polling results. */
  payouts: {
    polled: number;
    settled: number;
    notes: string[];
  };
  /** Funding re-verification results for this scan (Stage 14B follow-up). */
  funding: {
    /** Candidates that had a recoverable, still-live provider attempt. */
    reverified: number;
    /** Candidates with no recorded provider attempt (reported only). */
    noAttempt: number;
    /** Candidates whose latest attempt is definitively FAILED (skip: stale ≠ failure). */
    skippedFailedAttempt: number;
    /** Outcomes of the verification calls that ran. */
    outcomes: Array<{
      obligationId: string;
      outcome: "FUNDED" | "FAILED" | "PROCESSING" | "unavailable";
      code?: string;
    }>;
  };
};

/** Obligations in PROCESSING for longer than this are reconciliation candidates. */
export const PROCESSING_STUCK_THRESHOLD_MINUTES = 30;

/** Max candidates re-verified per scan (small on purpose; the scheduler re-invokes). */
const MAX_FUNDING_RECHECKS_PER_SCAN = 100;

export async function runReconciliationScan(options?: {
  now?: Date;
  thresholdMinutes?: number;
}): Promise<ReconciliationReport> {
  const now = options?.now ?? new Date();
  const thresholdMinutes = options?.thresholdMinutes ?? PROCESSING_STUCK_THRESHOLD_MINUTES;
  const cutoff = new Date(now.getTime() - thresholdMinutes * 60 * 1000);

  // Older than the threshold, still PROCESSING — the provider was never
  // confirmed either way.
  const stuck = await prisma.financialObligation.findMany({
    where: {
      status: "PROCESSING",
      updatedAt: { lt: cutoff },
    },
    select: {
      id: true,
      obligationRef: true,
      status: true,
      currency: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "asc" },
    take: 100,
  });

  // Attach the latest provider transaction reference, when one exists, so the
  // verification gate re-verifies the charge the provider already knows about.
  const candidates: StuckObligation[] = [];
  const verifiableIds: string[] = [];
  let noAttempt = 0;
  let skippedFailedAttempt = 0;

  for (const row of stuck) {
    const lastTransaction = await prisma.paymentProviderTransaction.findFirst({
      where: { obligationId: row.id },
      orderBy: { initiatedAt: "desc" },
      select: { providerReference: true, providerStatus: true },
    });

    // Recoverability gates (all server-derived facts, no invented verification):
    //   - no attempt row at all → nothing to verify against the provider;
    //   - a definitively FAILED latest attempt → the only PROCESSING → FAILED
    //     edge is provider evidence, and staleness is never evidence. The
    //     obligation is reported, never auto-failed, never re-verified.
    if (!lastTransaction) {
      noAttempt += 1;
    } else if (lastTransaction.providerStatus === "FAILED") {
      skippedFailedAttempt += 1;
    } else {
      verifiableIds.push(row.id);
    }

    candidates.push({
      obligationId: row.id,
      obligationRef: row.obligationRef,
      status: row.status,
      currency: row.currency,
      stuckSince: row.updatedAt,
      ageMinutes: Math.floor((now.getTime() - row.updatedAt.getTime()) / 60000),
      providerReference: lastTransaction?.providerReference ?? null,
      providerTransactionStatus: lastTransaction?.providerStatus ?? null,
    });
  }

  // Re-verify the eligible candidates through the EXISTING Stage 14B gate.
  // The gate itself refuses anything that is not PROCESSING any more (state
  // moved between the scan and the call), replays idempotently for an
  // already-resolved obligation, and re-checks amount/currency server-side.
  const fundingOutcomes: ReconciliationReport["funding"]["outcomes"] = [];
  let providerChecksPerformed = false;

  if (verifiableIds.length > 0) {
    for (const obligationId of verifiableIds.slice(0, MAX_FUNDING_RECHECKS_PER_SCAN)) {
      try {
        const outcome = await verifyAndSettleFunding(obligationId);

        if (outcome.ok) {
          fundingOutcomes.push({
            obligationId,
            outcome: outcome.status,
          });

          // A fresh FUNDED/FAILED transition is always downstream of a real
          // provider verification call. An idempotent replay can be the
          // gate's pre-provider no-op (the obligation resolved between the
          // scan and this call), so it does not prove a check happened and
          // is not counted.
          if (!outcome.idempotentReplay) {
            providerChecksPerformed = true;
          }
        } else {
          // UNVERIFIED / AMOUNT_MISMATCH / CURRENCY_MISMATCH /
          // PROVIDER_UNAVAILABLE / INVALID_STATE / NOT_FOUND: the gate left
          // the obligation untouched (still PROCESSING for the retryable
          // kinds) — surface the explicit code for the operator report.
          fundingOutcomes.push({
            obligationId,
            outcome: outcome.code === "PROVIDER_UNAVAILABLE" ? "unavailable" : "PROCESSING",
            code: outcome.code,
          });

          // Refusals issued BEFORE any provider contact (NOT_FOUND,
          // INVALID_STATE, PROVIDER_UNCONFIGURED — e.g. dormant mode) did
          // not check the provider; every other refusal code is decided
          // from a verification result, so a check did happen.
          const refusedBeforeProviderContact =
            outcome.code === "NOT_FOUND" ||
            outcome.code === "INVALID_STATE" ||
            outcome.code === "PROVIDER_UNCONFIGURED";

          if (!refusedBeforeProviderContact) {
            providerChecksPerformed = true;
          }
        }
      } catch (error) {
        // The gate throws only on infrastructure failure; the obligation is
        // untouched (still PROCESSING) and the next scan retries it. The
        // failure's timing relative to any provider call is unknown, so it
        // is NOT counted as a performed provider check.
        console.error(`reconciliation: funding re-verification failed for ${obligationId}`, error);

        fundingOutcomes.push({
          obligationId,
          outcome: "unavailable",
        });
      }
    }
  }

  // Stage 14C: converge in-flight creator payout attempts through provider
  // status polling (never auto-retry, never infer failure from a timeout).
  let payoutNotes: string[] = [];
  let payoutsPolled = 0;
  let payoutsSettled = 0;

  try {
    const { pollPendingPayouts, ensurePayoutsStartedForReleasedMilestones } = await import(
      "@/services/payments/payout.service"
    );

    // First make sure every RELEASED milestone actually has its payout flow
    // started (crash catch-up), then poll whatever is in flight.
    await ensurePayoutsStartedForReleasedMilestones();

    const payoutReport = await pollPendingPayouts({ now, thresholdMinutes });

    payoutsPolled = payoutReport.polled;
    payoutsSettled = payoutReport.settled;
    payoutNotes = payoutReport.notes;
  } catch (error) {
    // Dormant provider or provider outage: the payout half stays read-only.
    payoutNotes = [
      error instanceof Error
        ? `payout polling skipped: ${error.message.slice(0, 200)}`
        : "payout polling skipped",
    ];
  }

  return {
    scannedAt: now,
    stuckCount: candidates.length,
    candidates,
    providerChecksPerformed,
    note:
      "Stuck PROCESSING obligations with a recorded provider attempt are re-verified " +
      "server-side through the funding verification gate (amount + currency must " +
      "match the frozen obligation). Timeouts never imply failure — obligations " +
      "stay in PROCESSING until the provider confirms a definitive outcome. " +
      "Stage 14C payout attempts ARE polled to a definitive outcome " +
      "(success/failed/reversed) or left pending.",
    payouts: {
      polled: payoutsPolled,
      settled: payoutsSettled,
      notes: payoutNotes,
    },
    funding: {
      reverified: verifiableIds.length,
      noAttempt,
      skippedFailedAttempt,
      outcomes: fundingOutcomes,
    },
  };
}
