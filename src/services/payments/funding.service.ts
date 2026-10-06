import "server-only";

import { prisma } from "@/lib/prisma";
import { toMinorUnits, isPositiveMinor } from "@/lib/money";
import type { PrepareFundingInput } from "@/validation/funding";
import { createObligationForAgreement } from "@/services/payments/obligation.service";
import { planMilestonesForAgreement } from "@/services/payments/milestone.service";
import type { AgreementFeeMode } from "@/services/payments/fee-engine";

/**
 * Stage 14A — advertiser funding preparation.
 *
 * The single seam that makes Stages 12 → 13A → 13B → 13C reachable: an
 * advertiser turns an ACCEPTED (ACTIVE), unfunded agreement into a real
 * financial obligation plus its explicit milestones.
 *
 * What this module does NOT do (by design):
 *   - it NEVER marks anything FUNDED or paid: the obligation stays in its
 *     existing 13A state (PENDING_PAYMENT) until a Stage 14B payment
 *     provider VERIFIES real money. Nothing here implies money moved;
 *   - it implements NO new state machine: the obligation keeps its 13A
 *     lifecycle and milestones keep their 13B lifecycle — preparation only
 *     CREATES rows through the existing services, inside ONE transaction;
 *   - it never invents amounts: the obligation derives from the frozen
 *     agreement through the 13A money boundary, and milestone amounts are
 *     the advertiser's explicit terms, reconciled EXACTLY to the agreement
 *     total by the 13B planner (BigInt minor units, no drift, no splits).
 *
 * Authorization: the caller passes the session-derived advertiser profile
 * id; every read filters on it INSIDE the query. A creator or an unrelated
 * advertiser can never prepare, read or observe another party's funding —
 * and a foreign agreement id is indistinguishable from a missing one.
 */

export type FundingPreparationErrorCode =
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "INVALID_STATE"
  | "ALREADY_PREPARED"
  | "FEE_NOT_CONFIGURED"
  | "INVALID_TERMS"
  | "INVALID_AGREEMENT_AMOUNT"
  | "CONCURRENT_CONFLICT";

export type PreparedMilestoneTerm = {
  milestoneId: string;
  position: number;
  title: string;
  creatorAmountMinor: bigint;
  currency: string;
};

export type PrepareFundingResult =
  | {
      ok: true;
      obligationId: string;
      obligationRef: string;
      currency: string;
      /** Creator amount, from the frozen agreement (BigInt minor units). */
      creatorAmountMinor: bigint;
      /** 13A AGREEMENT_FUNDING fee (server-side config), minor units. */
      platformFeeMinor: bigint;
      /** creatorAmountMinor + platformFeeMinor — the advertiser's total. */
      advertiserTotalMinor: bigint;
      milestones: PreparedMilestoneTerm[];
    }
  | { ok: false; code: FundingPreparationErrorCode; reason: string };

/**
 * Advertiser-owned ACTIVE agreement read. The ownership predicate lives
 * INSIDE the query — a guessed or foreign agreement id reads as null, never
 * an error that leaks existence (mirrors agreement.service conventions).
 */
function ownedAgreementWhere(advertiserProfileId: string) {
  return {
    advertiserId: advertiserProfileId,
    status: "ACTIVE" as const,
  };
}

export async function getFundingPreparationForAdvertiser(
  agreementId: string,
  advertiserProfileId: string,
): Promise<{
  agreementId: string;
  agreedAmount: string;
  currency: string;
} | null> {
  const agreement = await prisma.campaignAgreement.findFirst({
    where: {
      id: agreementId,
      ...ownedAgreementWhere(advertiserProfileId),
    },
    select: {
      id: true,
      agreedAmount: true,
      currency: true,
    },
  });

  if (!agreement) {
    return null;
  }

  return {
    agreementId: agreement.id,
    agreedAmount: agreement.agreedAmount.toString(),
    currency: agreement.currency,
  };
}

/**
 * Thrown inside the preparation transaction to roll back a refused step.
 * A refusal must NEVER be returned from the transaction callback: returning
 * would COMMIT the obligation rows written moments earlier, while throwing
 * rolls the whole transaction back (same pattern as SettlementRefusedError
 * in the 13B settlement path).
 */
class FundingPreparationRefusedError extends Error {
  constructor(
    readonly refusal: {
      code:
        | "ALREADY_PREPARED"
        | "FEE_NOT_CONFIGURED"
        | "INVALID_TERMS"
        | "INVALID_AGREEMENT_AMOUNT"
        | "CONCURRENT_CONFLICT";
      reason: string;
    },
  ) {
    super(refusal.reason);
    this.name = "FundingPreparationRefusedError";
  }
}

/**
 * Prepare funding for one advertiser-owned agreement:
 *
 *   1. Load + authorize the agreement (advertiser-owned, ACTIVE) — fail
 *      closed on ownership or state, indistinguishably;
 *   2. Refuse already-prepared agreements before any write;
 *   3. Validate the explicit terms (positive amounts, exact reconciliation)
 *      BEFORE any write;
 *   4. In ONE transaction: create the 13A obligation (PENDING_PAYMENT —
 *      never FUNDED) and plan the 13B milestones from the explicit terms
 *      (reconciliation re-enforced authoritatively inside the planner).
 *
 * Rollback discipline: obligation creation and milestone planning run inside
 * a single prisma.$transaction. If milestone planning fails AFTER the
 * obligation rows are written, the whole transaction rolls back — no orphan
 * obligation, no partial milestones, nothing to clean up. (A compensating
 * delete is not an option here: FinancialEvent rows carry an onDelete:
 * Restrict FK to the obligation and the financial event log is append-only,
 * so the obligation must never be deleted at all.)
 *
 * Concurrency/duplicate safety: the obligation's unique `agreementId` and
 * the milestones' unique (agreementId, position) are the arbiters. A racing
 * duplicate call either hits the pre-checked ALREADY_PREPARED refusal or
 * loses the unique-constraint race and reports ALREADY_PREPARED — never a
 * partial or doubled preparation, and never a second funding state machine.
 */
export async function prepareFundingForAgreement(
  agreementId: string,
  advertiserProfileId: string,
  input: PrepareFundingInput,
): Promise<PrepareFundingResult> {
  // ---- 1. Load + authorize the agreement (fail closed). ----
  const agreement = await prisma.campaignAgreement.findFirst({
    where: {
      id: agreementId,
      ...ownedAgreementWhere(advertiserProfileId),
    },
    select: {
      id: true,
      agreedAmount: true,
      currency: true,
      status: true,
      campaignId: true,
      creatorId: true,
    },
  });

  if (!agreement) {
    // Not found OR not yours OR not ACTIVE — the same refusal either way, so
    // nothing about other parties' agreements can be probed.
    return {
      ok: false,
      code: "NOT_FOUND",
      reason:
        "This agreement does not exist, is not yours, or is no longer active.",
    };
  }

  // ---- 2. Reject already-prepared agreements before any write. ----
  const [existingObligation, existingMilestone] = await Promise.all([
    prisma.financialObligation.findUnique({
      where: { agreementId: agreement.id },
      select: { id: true },
    }),
    prisma.milestone.findFirst({
      where: { agreementId: agreement.id },
      select: { id: true },
    }),
  ]);

  if (existingObligation || existingMilestone) {
    return {
      ok: false,
      code: "ALREADY_PREPARED",
      reason:
        "Funding has already been prepared for this agreement. Track its payment status on the agreement page.",
    };
  }

  // ---- 3. Validate the explicit terms BEFORE any write. ----
  // Positions must be exactly 1..n without gaps or duplicates; amounts must
  // be positive fixed-point values; and the terms must reconcile EXACTLY to
  // the agreement total in minor units. (The 13B planner re-enforces all of
  // this authoritatively — this pre-check exists so preparation fails fast
  // and never leaves a partially prepared agreement behind.)
  const terms = input.milestones;

  const seenPositions = new Set<number>();
  const termAmountsMinor: bigint[] = [];

  for (const term of terms) {
    const position = Math.floor(term.position);

    if (
      !Number.isSafeInteger(position) ||
      position < 1 ||
      position > terms.length ||
      seenPositions.has(position)
    ) {
      return {
        ok: false,
        code: "INVALID_TERMS",
        reason: `Milestone positions must be 1..${terms.length} without gaps or duplicates.`,
      };
    }

    seenPositions.add(position);

    let amountMinor: bigint;

    try {
      amountMinor = toMinorUnits(term.creatorAmount, agreement.currency);
    } catch {
      return {
        ok: false,
        code: "INVALID_TERMS",
        reason: `Milestone ${position} has an invalid amount (${term.creatorAmount}) for ${agreement.currency}.`,
      };
    }

    if (!isPositiveMinor(amountMinor)) {
      return {
        ok: false,
        code: "INVALID_TERMS",
        reason: `Milestone ${position} amount must be greater than zero.`,
      };
    }

    termAmountsMinor.push(amountMinor);
  }

  let agreementTotalMinor: bigint;

  try {
    agreementTotalMinor = toMinorUnits(
      agreement.agreedAmount.toString(),
      agreement.currency,
    );
  } catch {
    return {
      ok: false,
      code: "INVALID_AGREEMENT_AMOUNT",
      reason: "The agreement amount cannot be represented exactly in minor units.",
    };
  }

  const termsTotalMinor = termAmountsMinor.reduce(
    (sum, amountMinor) => sum + amountMinor,
    0n,
  );

  if (termsTotalMinor !== agreementTotalMinor) {
    return {
      ok: false,
      code: "INVALID_TERMS",
      reason:
        termsTotalMinor < agreementTotalMinor
          ? "Milestone amounts do not yet cover the agreed amount — every kobo of the agreement must be allocated to exactly one milestone."
          : "Milestone amounts exceed the agreed amount — milestone totals must reconcile exactly to the agreement.",
    };
  }

  // ---- 4. ONE transaction: 13A obligation + 13B milestones. ----

  // The two advertiser fee mechanisms are mutually exclusive, and which one
  // applies is decided HERE, once, from the number of explicit milestone
  // terms the advertiser submitted:
  //
  //   ONE term  -> a single-payment agreement. The 5% AGREEMENT_FUNDING fee
  //                is charged UPFRONT (inside advertiserTotalMinor) and the
  //                per-milestone advertiser fee is zero.
  //   2+ terms  -> a multi-milestone agreement. The advertiser funds ONLY the
  //                creator's agreed money (platformFeeMinor = 0) and pays the
  //                5% MILESTONE_ADVERTISER_FEE per milestone at settlement,
  //                collected from the advertiser and never out of escrow.
  const feeMode: AgreementFeeMode = terms.length === 1 ? "SINGLE_PAYMENT" : "MILESTONE";
  try {
    const prepared = await prisma.$transaction(async (tx) => {
      const obligation = await createObligationForAgreement(agreement.id, {
        tx,
        feeMode,
      });

      if (!obligation.ok) {
        // Fee-config / amount problems: refused before any write, but throwing
        // keeps the rollback discipline uniform.
        throw new FundingPreparationRefusedError({
          code:
            obligation.code === "FEE_NOT_CONFIGURED"
              ? "FEE_NOT_CONFIGURED"
              : "INVALID_AGREEMENT_AMOUNT",
          reason: obligation.reason,
        });
      }

      if (obligation.alreadyExisted) {
        // A concurrent call won the unique race between our pre-check and
        // this write. Throwing rolls the transaction back and the caller
        // reports ALREADY_PREPARED.
        throw new FundingPreparationRefusedError({
          code: "ALREADY_PREPARED",
          reason:
            "Funding has already been prepared for this agreement. Track its payment status on the agreement page.",
        });
      }

      const planned = await planMilestonesForAgreement(
        agreement.id,
        {
          milestones: terms.map((term) => ({
            position: term.position,
            title: term.title,
            deliverables: term.deliverables,
            startDate: term.startDate,
            dueDate: term.dueDate,
            creatorAmount: term.creatorAmount,
          })),
          feeMode,
        },
        { tx },
      );

      if (!planned.ok) {
        // Throwing rolls back the obligation + its creation event written
        // above: no obligation, no milestones, no events — the agreement is
        // left exactly as it was.
        throw new FundingPreparationRefusedError({
          code:
            planned.code === "INVALID_MILESTONE_TERMS" ||
            planned.code === "INVALID_MILESTONE_COUNT"
              ? "INVALID_TERMS"
              : planned.code === "FEE_NOT_CONFIGURED"
                ? "FEE_NOT_CONFIGURED"
                : planned.code === "PLANNING_FAILED"
                  ? "CONCURRENT_CONFLICT"
                  : "INVALID_AGREEMENT_AMOUNT",
          reason:
            planned.code === "PLANNING_FAILED"
              ? "Funding preparation could not be completed. Nothing was recorded — please try again."
              : planned.reason,
        });
      }

      return { obligation, planned };
    });

    const { obligation } = prepared;

    // ---- 5. Read back the created milestones for the confirmation view. ----
    const milestones = await prisma.milestone.findMany({
      where: { agreementId: agreement.id },
      orderBy: { position: "asc" },
      select: {
        id: true,
        position: true,
        title: true,
        creatorAmountMinor: true,
        currency: true,
      },
    });

    return {
      ok: true,
      obligationId: obligation.obligationId,
      obligationRef: obligation.obligationRef,
      currency: obligation.currency,
      creatorAmountMinor: obligation.creatorAmountMinor,
      platformFeeMinor: obligation.platformFeeMinor,
      advertiserTotalMinor: obligation.advertiserTotalMinor,
      milestones: milestones.map((milestone) => ({
        milestoneId: milestone.id,
        position: milestone.position,
        title: milestone.title,
        creatorAmountMinor: milestone.creatorAmountMinor,
        currency: milestone.currency,
      })),
    };
  } catch (error) {
    // Refusals thrown inside the transaction arrive here after the rollback.
    if (error instanceof FundingPreparationRefusedError) {
      return { ok: false, code: error.refusal.code, reason: error.refusal.reason };
    }

    // The transaction already rolled back — nothing was persisted. What is
    // left is to classify the failure honestly.
    console.error("prepareFundingForAgreement failed", error);

    // A concurrent duplicate that slipped past every pre-check loses the
    // obligation's unique constraint here; converge on ALREADY_PREPARED.
    const isUniqueViolation =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2002";

    if (isUniqueViolation) {
      return {
        ok: false,
        code: "ALREADY_PREPARED",
        reason:
          "Funding has already been prepared for this agreement. Track its payment status on the agreement page.",
      };
    }

    return {
      ok: false,
      code: "CONCURRENT_CONFLICT",
      reason:
        "Funding preparation could not be completed. Nothing was recorded — please try again.",
    };
  }
}

/**
 * Idempotent read used by the agreements page: the advertiser sees the
 * obligation's REAL state (PENDING_PAYMENT = awaiting provider funding) and
 * the frozen milestone breakdown. Party-scoped like every other read.
 */
export async function getFundingStatusForAdvertiser(
  agreementId: string,
  advertiserProfileId: string,
): Promise<{
  obligation: {
    id: string;
    obligationRef: string;
    status: string;
    escrowFunded: boolean;
    creatorAmountMinor: bigint;
    platformFeeMinor: bigint;
    advertiserTotalMinor: bigint;
    currency: string;
  } | null;
  milestones: Array<{
    id: string;
    position: number;
    title: string;
    status: string;
    creatorAmountMinor: bigint;
    currency: string;
  }>;
} | null> {
  const agreement = await prisma.campaignAgreement.findFirst({
    where: {
      id: agreementId,
      ...ownedAgreementWhere(advertiserProfileId),
    },
    select: { id: true },
  });

  if (!agreement) {
    return null;
  }

  const [obligation, milestones] = await Promise.all([
    prisma.financialObligation.findUnique({
      where: { agreementId: agreement.id },
      select: {
        id: true,
        obligationRef: true,
        status: true,
        escrowFunded: true,
        creatorAmountMinor: true,
        platformFeeMinor: true,
        advertiserTotalMinor: true,
        currency: true,
      },
    }),
    prisma.milestone.findMany({
      where: { agreementId: agreement.id },
      orderBy: { position: "asc" },
      select: {
        id: true,
        position: true,
        title: true,
        status: true,
        creatorAmountMinor: true,
        currency: true,
      },
    }),
  ]);

  return { obligation, milestones };
}
