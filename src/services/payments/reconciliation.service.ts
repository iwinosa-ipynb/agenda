import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * Stage 13A — reconciliation job stub.
 *
 * Purpose: a scheduled boundary that finds obligations stuck in an
 * intermediate state (today: PROCESSING) and defines WHERE provider state
 * checks will run. Stage 13A does NOT call any provider.
 *
 * Critical semantics:
 *   - A timeout is NOT evidence of payment failure. The stub never moves an
 *     obligation to FAILED on its own — provider verification (Stage 13B)
 *     is the only mechanism that may resolve PROCESSING to FUNDED or FAILED.
 *   - Output is a report for operators/logs only.
 *
 * Future mechanism (Stage 13B): for each candidate, call
 * provider.verifyTransaction(...) with the obligation's expected amounts and
 * drive the result through the state machine's verified paths.
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
  /** Always true in Stage 13A: no provider was contacted for OBLIGATIONS. */
  providerChecksPerformed: false;
  note: string;
  /** Stage 14C — payout-attempt polling results. */
  payouts: {
    polled: number;
    settled: number;
    notes: string[];
  };
};

/** Obligations in PROCESSING for longer than this are reported as stuck. */
export const PROCESSING_STUCK_THRESHOLD_MINUTES = 30;

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

  // Attach the latest provider transaction reference, when one exists, so
  // Stage 13B can verify it against the provider.
  const candidates: StuckObligation[] = [];

  for (const row of stuck) {
    const lastTransaction = await prisma.paymentProviderTransaction.findFirst({
      where: { obligationId: row.id },
      orderBy: { initiatedAt: "desc" },
      select: { providerReference: true, providerStatus: true },
    });

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
    // Dormant provider or provider outage: the scan stays read-only.
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
    providerChecksPerformed: false,
    note:
      "Stage 13A stub for obligations: no provider contacted. Timeouts never imply failure — " +
      "obligations stay in PROCESSING until provider verification (Stage 13B) " +
      "resolves them to FUNDED or FAILED. Stage 14C payout attempts ARE polled " +
      "to a definitive outcome (success/failed/reversed) or left pending.",
    payouts: {
      polled: payoutsPolled,
      settled: payoutsSettled,
      notes: payoutNotes,
    },
  };
}
