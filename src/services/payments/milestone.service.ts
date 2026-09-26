import "server-only";

import type { Prisma } from "@/generated/prisma/client";

import { prisma } from "@/lib/prisma";
import { feeFor, toMinorUnits } from "@/lib/money";
import type { MilestoneState } from "@/services/payments/milestone-state-machine";
import { getMilestoneFeeConfigurations } from "@/services/payments/fee-config.service";
import {
  transitionObligation,
  transitionEventKey,
} from "@/services/payments/obligation-state.service";

/**
 * Stage 13B — milestones: planning, reads, and settlement.
 *
 * Planning derives one Milestone row per deliverable stage directly from the
 * FROZEN CampaignAgreement — the agreement (not the rate card, not the
 * campaign budget, not any client input) remains the sole source of truth.
 * A single-deliverable agreement plans exactly one milestone covering 100%
 * of the agreed amount; multi-milestone plans use equal splits (per-milestone
 * terms land with the agreement-format work of a later stage).
 *
 * Financial integration: NO second financial system. Funding is the Stage 13A
 * obligation's provider-verified escrow (a milestone can never be reviewed,
 * confirmed or released while unfunded), and settlement moves the money
 * through the 13A ledger/state machine. Paystack processing fees are separate
 * from Agenda revenue and are never refunded. Provider payout execution stays
 * behind the Stage 13A port — this stage records the earned settlement in the
 * ledger; no live transfer is executed.
 */

/**
 * One milestone's EXPLICIT terms, supplied by the server planning path —
 * never derived by splitting the total, never taken from a client.
 */
export type MilestonePlanInput = {
  /** 1-based sequence within the agreement. */
  position: number;
  title?: string;
  /** This milestone's own deliverables (may differ per milestone). */
  deliverables?: string | null;
  /**
   * How many platform posts this milestone requires (Stage 13C). Frozen from
   * the explicit terms — never inferred from post counts or client input.
   * Defaults to 1.
   */
  requiredPostCount?: number;
  startDate?: Date | null;
  dueDate?: Date | null;
  /**
   * This milestone's explicit creator amount as a fixed-point Decimal string
   * (e.g. "200000.00"). Required. Never derived from the campaign budget or
   * the rate card; converted exactly once via the 13A money boundary.
   */
  creatorAmount: string;
};

export type MilestonePlanResult =
  | {
      ok: true;
      created: number;
      milestoneIds: string[];
      /** True when milestones already existed (idempotent replay). */
      alreadyPlanned: boolean;
    }
  | {
      ok: false;
      code:
        | "AGREEMENT_NOT_FOUND"
        | "AGREEMENT_NOT_ACTIVE"
        | "FEE_NOT_CONFIGURED"
        | "INVALID_AGREEMENT_AMOUNT"
        | "INVALID_MILESTONE_TERMS"
        | "INVALID_MILESTONE_COUNT"
        | "PLANNING_FAILED";
      reason: string;
    };

/** Deterministic, auditable milestone reference. */
function buildMilestoneRef(agreementId: string, position: number): string {
  return `MIL-${agreementId.replace(/-/g, "").slice(0, 12).toUpperCase()}-${position}`;
}

/**
 * Plan the milestones for an agreement from EXPLICIT milestone terms.
 *
 * BUSINESS RULE (13B audit correction): milestone amounts are NEVER derived
 * by splitting the agreement total. Every milestone must carry its own
 * explicit amount (e.g. a ₦900,000 agreement as ₦200k / ₦300k / ₦400k) plus
 * its own deliverables and optional schedule. The ONLY arithmetic performed
 * here is the reconciliation check: the explicit milestone amounts must sum
 * EXACTLY to the frozen agreement amount — no more, no less.
 *
 * Where do the explicit terms come from? Today the agreement format has a
 * single agreedAmount + deliverables blob, so the server-side planner
 * (agreement formation / funding flow) must supply the explicit per-milestone
 * terms when it calls this function. They are frozen verbatim and can never
 * be changed afterwards by any client action. When the agreement format grows
 * per-milestone terms, this function's input simply switches to reading them
 * from the frozen agreement row.
 *
 * Single-milestone agreements may call this with no terms: the milestone then
 * covers the whole agreement amount (the one case where "derivation" is
 * exact by definition, not a split).
 *
 * Idempotent via the (agreementId, position) unique constraint.
 *
 * Fees (advertiser service fee, creator commission) derive from each
 * milestone's OWN amount via the ACTIVE typed fee configuration rows —
 * never hard-coded. The creator NEVER pays a deposit.
 */
export async function planMilestonesForAgreement(
  agreementId: string,
  options: { milestones?: MilestonePlanInput[] } = {},
  /**
   * Pass a transaction client to run inside a caller-managed transaction
   * (Stage 14A funding preparation); defaults to the module client.
   */
  txOptions: { tx?: Prisma.TransactionClient } = {},
): Promise<MilestonePlanResult> {
  const db = txOptions.tx ?? prisma;

  const agreement = await db.campaignAgreement.findUnique({
    where: { id: agreementId },
    select: {
      id: true,
      status: true,
      agreedAmount: true,
      currency: true,
      campaignId: true,
      advertiserId: true,
      creatorId: true,
      deliverables: true,
    },
  });

  if (!agreement) {
    return {
      ok: false,
      code: "AGREEMENT_NOT_FOUND",
      reason: "No agreement exists with this id.",
    };
  }

  if (agreement.status !== "ACTIVE") {
    return {
      ok: false,
      code: "AGREEMENT_NOT_ACTIVE",
      reason: "Milestones can only be planned for active agreements.",
    };
  }

  // Idempotency check BEFORE any write.
  const existing = await db.milestone.count({ where: { agreementId } });

  if (existing > 0) {
    return {
      ok: true,
      created: 0,
      milestoneIds: [],
      alreadyPlanned: true,
    };
  }

  // Server-side fee configuration — typed rows, never hard-coded percentages.
  const feeConfigs = await getMilestoneFeeConfigurations(agreement.currency);

  if (!feeConfigs.ok) {
    return {
      ok: false,
      code: "FEE_NOT_CONFIGURED",
      reason:
        "No ACTIVE milestone fee configuration exists for this currency (advertiser service fee and/or creator commission).",
    };
  }

  let agreementTotalMinor: bigint;

  try {
    agreementTotalMinor = toMinorUnits(agreement.agreedAmount.toString(), agreement.currency);
  } catch {
    return {
      ok: false,
      code: "INVALID_AGREEMENT_AMOUNT",
      reason: "The agreement amount cannot be represented exactly in minor units.",
    };
  }

  // An EXPLICIT empty plan is invalid — never silently derived.
  if (options.milestones !== undefined && options.milestones.length === 0) {
    return {
      ok: false,
      code: "INVALID_MILESTONE_TERMS",
      reason:
        "Explicit milestone terms are required for multi-milestone agreements — amounts are never derived by splitting the total.",
    };
  }

  // Terms come either from the caller (explicit plan) or, for a
  // single-milestone agreement, default to the WHOLE agreement amount —
  // exact by definition, not a split.
  const terms: MilestonePlanInput[] =
    options.milestones ??
    [
      {
        position: 1,
        title: "Agreed deliverable",
        deliverables: agreement.deliverables,
        creatorAmount: agreement.agreedAmount.toString(),
      },
    ];

  if (terms.length < 1 || terms.length > 52) {
    return {
      ok: false,
      code: "INVALID_MILESTONE_COUNT",
      reason: "An agreement supports between 1 and 52 milestones.",
    };
  }

  // Validate + convert every explicit term BEFORE writing anything.
  const planned: Array<{
    position: number;
    title: string;
    deliverables: string | null;
    requiredPostCount: number;
    startDate: Date | null;
    dueDate: Date | null;
    creatorAmountMinor: bigint;
    advertiserServiceFeeMinor: bigint;
    creatorCommissionMinor: bigint;
    advertiserTotalMinor: bigint;
  }> = [];

  const seenPositions = new Set<number>();
  let sumMinor = 0n;

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
        code: "INVALID_MILESTONE_TERMS",
        reason: `Milestone positions must be 1..${terms.length} without gaps or duplicates (got ${term.position}).`,
      };
    }

    seenPositions.add(position);

    let creatorAmountMinor: bigint;

    try {
      creatorAmountMinor = toMinorUnits(term.creatorAmount, agreement.currency);
    } catch {
      return {
        ok: false,
        code: "INVALID_MILESTONE_TERMS",
        reason: `Milestone ${position} has an invalid amount (${term.creatorAmount}) for ${agreement.currency}.`,
      };
    }

    if (creatorAmountMinor <= 0n) {
      return {
        ok: false,
        code: "INVALID_MILESTONE_TERMS",
        reason: `Milestone ${position} amount must be greater than zero.`,
      };
    }

    if (
      term.startDate instanceof Date &&
      term.dueDate instanceof Date &&
      term.startDate.getTime() > term.dueDate.getTime()
    ) {
      return {
        ok: false,
        code: "INVALID_MILESTONE_TERMS",
        reason: `Milestone ${position} start date must be on or before its due date.`,
      };
    }

    const requiredPostCount = Math.floor(term.requiredPostCount ?? 1);

    if (!Number.isSafeInteger(requiredPostCount) || requiredPostCount < 1 || requiredPostCount > 100) {
      return {
        ok: false,
        code: "INVALID_MILESTONE_TERMS",
        reason: `Milestone ${position} required post count must be between 1 and 100.`,
      };
    }

    // Fees derive from THIS milestone's own amount, floor-rounded.
    const advertiserFeeMinor = feeFor(creatorAmountMinor, feeConfigs.advertiserRate.feeBasisPoints);
    const creatorCommissionMinor = feeFor(creatorAmountMinor, feeConfigs.creatorRate.feeBasisPoints);
    const advertiserTotalMinor = creatorAmountMinor + advertiserFeeMinor;

    sumMinor += creatorAmountMinor;

    planned.push({
      position,
      title: term.title?.trim() || `Milestone ${position}`,
      deliverables: term.deliverables?.trim() || agreement.deliverables,
      requiredPostCount,
      startDate: term.startDate ?? null,
      dueDate: term.dueDate ?? null,
      creatorAmountMinor,
      advertiserServiceFeeMinor: advertiserFeeMinor,
      creatorCommissionMinor,
      advertiserTotalMinor,
    });
  }

  // THE reconciliation invariant: explicit milestone amounts must sum to the
  // frozen agreement amount EXACTLY — in minor units, no rounding drift.
  if (sumMinor !== agreementTotalMinor) {
    return {
      ok: false,
      code: "INVALID_MILESTONE_TERMS",
      reason:
        "Milestone amounts do not reconcile exactly to the agreed amount — adjust the explicit milestone amounts (they must sum to the agreement total).",
    };
  }

  const rows: Array<Prisma.MilestoneCreateInput> = planned.map((plan) => ({
    agreement: { connect: { id: agreementId } },
    campaignId: agreement.campaignId,
    advertiserId: agreement.advertiserId,
    creatorId: agreement.creatorId,
    milestoneRef: buildMilestoneRef(agreementId, plan.position),
    position: plan.position,
    title: plan.title,
    deliverables: plan.deliverables,
    requiredPostCount: plan.requiredPostCount,
    startDate: plan.startDate,
    dueDate: plan.dueDate,
    creatorAmountMinor: plan.creatorAmountMinor,
    advertiserServiceFeeMinor: plan.advertiserServiceFeeMinor,
    creatorCommissionMinor: plan.creatorCommissionMinor,
    advertiserTotalMinor: plan.advertiserTotalMinor,
    currency: agreement.currency,
    advertiserFeeConfigId: feeConfigs.advertiserFee.id,
    creatorFeeConfigId: feeConfigs.creatorFee.id,
    status: "PENDING",
  }));

  try {
    // Inside a caller-managed transaction (Stage 14A funding preparation) the
    // writes already share the caller's atomicity — and transaction clients
    // cannot nest $transaction — so the rows are written directly. Standalone
    // calls keep the array-form transaction.
    const created = txOptions.tx
      ? await Promise.all(rows.map((data) => db.milestone.create({ data, select: { id: true } })))
      : await db.$transaction(
          rows.map((data) => db.milestone.create({ data, select: { id: true } })),
        );

    const milestoneIds = created.map((row) => row.id);

    // One milestone_defined event per milestone (idempotent keys).
    await db.milestoneEvent.createMany({
      data: rows.map((data, index) => ({
        milestoneId: milestoneIds[index] as string,
        agreementId,
        eventType: "milestone_defined" as const,
        actor: "SYSTEM",
        actorId: null,
        source: "milestone-service",
        details: {
          milestoneRef: data.milestoneRef,
          position: data.position,
          creatorAmountMinor: data.creatorAmountMinor.toString(),
          advertiserServiceFeeMinor: data.advertiserServiceFeeMinor.toString(),
          creatorCommissionMinor: data.creatorCommissionMinor.toString(),
          advertiserTotalMinor: data.advertiserTotalMinor.toString(),
          currency: agreement.currency,
        },
        idempotencyKey: `mevt:${milestoneIds[index]}:milestone_defined`,
      })),
    });

    return { ok: true, created: rows.length, milestoneIds, alreadyPlanned: false };
  } catch (error) {
    // A race that slipped past the pre-check: the unique constraint wins and
    // the milestones already exist — serve them as already planned.
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      return { ok: true, created: 0, milestoneIds: [], alreadyPlanned: true };
    }

    console.error("planMilestonesForAgreement failed", error);

    // An infrastructure failure is NOT a term/amount problem — mislabeling it
    // INVALID_AGREEMENT_AMOUNT would lie about the frozen agreement. The
    // transaction has already rolled back, so nothing was written.
    return {
      ok: false,
      code: "PLANNING_FAILED",
      reason: "Could not plan the milestones.",
    };
  }
}

// ---------------------------------------------------------------------------
// Reads (party-scoped, mirroring agreement.service conventions)
// ---------------------------------------------------------------------------

const paidPostSelect = {
  id: true,
  platform: true,
  postUrl: true,
  caption: true,
  creatorNote: true,
  status: true,
  views: true,
  likes: true,
  comments: true,
  shares: true,
  verifiedViews: true,
  lastSyncedAt: true,
} satisfies Prisma.CampaignPostSelect;

const milestoneInclude = {
  paidPost: { select: paidPostSelect },
  // The agreement's frozen platform — submissions must match it (13C).
  agreement: { select: { platform: true } },
} satisfies Prisma.MilestoneInclude;

export type MilestoneView = Prisma.MilestoneGetPayload<{
  include: typeof milestoneInclude;
}>;

/**
 * All milestones of one agreement, visible ONLY to its parties. The
 * ownership filter lives inside the query — foreign/guessed ids return
 * null like every other service read.
 */
export async function listMilestonesForParty(
  agreementId: string,
  viewer: { advertiserId?: string; creatorId?: string },
): Promise<MilestoneView[] | null> {
  const agreement = await prisma.campaignAgreement.findFirst({
    where: {
      id: agreementId,
      ...(viewer.advertiserId !== undefined ? { advertiserId: viewer.advertiserId } : {}),
      ...(viewer.creatorId !== undefined ? { creatorId: viewer.creatorId } : {}),
    },
    select: { id: true },
  });

  if (!agreement) {
    return null;
  }

  return prisma.milestone.findMany({
    where: { agreementId },
    orderBy: { position: "asc" },
    include: milestoneInclude,
  });
}

/**
 * One milestone by id for an authorized party. Unrelated viewers get null —
 * never an error that leaks existence.
 */
export async function getMilestoneForParty(
  milestoneId: string,
  viewer: { advertiserId?: string; creatorId?: string },
): Promise<MilestoneView | null> {
  return prisma.milestone.findFirst({
    where: {
      id: milestoneId,
      ...(viewer.advertiserId !== undefined ? { advertiserId: viewer.advertiserId } : {}),
      ...(viewer.creatorId !== undefined ? { creatorId: viewer.creatorId } : {}),
    },
    include: milestoneInclude,
  });
}

/**
 * The full evidence chain for one milestone — support review data. Includes
 * the agreement, the funding state, the post, every milestone event and the
 * immutable financial events of the underlying obligation. Read-only: support
 * can never silently change financial amounts through this path.
 */
export async function getMilestoneEvidenceChain(milestoneId: string) {
  const milestone = await prisma.milestone.findUnique({
    where: { id: milestoneId },
    include: milestoneInclude,
  });

  if (!milestone) {
    return null;
  }

  const [agreement, obligation, events, financialEvents] = await Promise.all([
    prisma.campaignAgreement.findUnique({
      where: { id: milestone.agreementId },
      select: {
        id: true,
        status: true,
        agreedAmount: true,
        currency: true,
        deliverables: true,
        acceptedAt: true,
      },
    }),
    prisma.financialObligation.findUnique({
      where: { agreementId: milestone.agreementId },
      select: {
        id: true,
        status: true,
        escrowFunded: true,
        dispute: true,
        creatorAmountMinor: true,
        platformFeeMinor: true,
        advertiserTotalMinor: true,
        currency: true,
      },
    }),
    prisma.milestoneEvent.findMany({
      where: { milestoneId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        eventType: true,
        actor: true,
        actorId: true,
        source: true,
        details: true,
        createdAt: true,
      },
    }),
    prisma.financialEvent.findMany({
      where: { agreementId: milestone.agreementId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        eventType: true,
        actor: true,
        source: true,
        createdAt: true,
      },
      take: 200,
    }),
  ]);

  return {
    milestone,
    agreement: agreement
      ? {
          id: agreement.id,
          status: agreement.status,
          agreedAmount: agreement.agreedAmount.toString(),
          currency: agreement.currency,
          deliverables: agreement.deliverables,
          acceptedAt: agreement.acceptedAt,
        }
      : null,
    funding: obligation,
    post: milestone.paidPost,
    events,
    financialEvents,
  };
}

// ---------------------------------------------------------------------------
// Settlement — earns the fees through the Stage 13A financial layer
// ---------------------------------------------------------------------------

export type SettlementResult =
  | {
      ok: true;
      milestoneId: string;
      status: MilestoneState;
      idempotentReplay: boolean;
      ledgerEntryCount: number;
      obligationStatus: string;
    }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "UNAUTHORIZED"
        | "INVALID_STATE"
        | "FUNDING_MISSING"
        | "OBLIGATION_NOT_FOUND"
        | "SETTLEMENT_FAILED";
      reason: string;
    };

/**
 * Settle a milestone whose release has been confirmed (status
 * CONFIRMED_RELEASE): move it to SETTLEMENT_PENDING, then RELEASED, earning
 * the frozen amounts through the Stage 13A ledger.
 *
 * This is the ONLY path that turns milestone amounts into earned revenue:
 *   - the amounts come from the FROZEN milestone row (server-frozen from the
 *     agreement at plan time) — never from a client, budget or rate card;
 *   - funding is verified against the Stage 13A obligation's provider-verified
 *     escrow — an unfunded milestone can never be released;
 *   - the obligation moves through its own 13A state machine
 *     (FUNDED → SETTLEMENT_PENDING → RELEASED), so both lifecycles stay in
 *     lockstep without a second financial system;
 *   - ledger lines are written with the 13A idempotency-key discipline, so a
 *     replayed settlement is a no-op, never a double payout;
 *   - provider payout execution remains behind the Stage 13A port (no live
 *     transfer happens in this stage).
 */
export async function settleConfirmedMilestone(
  milestoneId: string,
  actor: { role: "SYSTEM" | "ADVERTISER" | "ADMIN"; actorId: string | null; source: string },
): Promise<SettlementResult> {
  const milestone = await prisma.milestone.findUnique({
    where: { id: milestoneId },
    select: {
      id: true,
      agreementId: true,
      milestoneRef: true,
      position: true,
      advertiserId: true,
      creatorId: true,
      creatorAmountMinor: true,
      advertiserServiceFeeMinor: true,
      creatorCommissionMinor: true,
      advertiserTotalMinor: true,
      currency: true,
      status: true,
    },
  });

  if (!milestone) {
    return { ok: false, code: "NOT_FOUND", reason: "Milestone not found." };
  }

  // Authorization: only the agreement's advertiser (or a system/admin path)
  // may trigger settlement; creators cannot confirm or release their own pay.
  // Uses the milestone's denormalized advertiserId — same value as the
  // agreement's, frozen at plan time.
  if (actor.role === "ADVERTISER" && milestone.advertiserId !== actor.actorId) {
    return {
      ok: false,
      code: "UNAUTHORIZED",
      reason: "Only the agreement's advertiser can trigger settlement.",
    };
  }

  // CONFIRMED_RELEASE is the advertiser path; SETTLEMENT_PENDING is the
  // support RELEASE_PAYMENT decision path (the decision already wrote it).
  // Both settle identically: frozen amounts, funding gates, 13A ledger.
  if (milestone.status !== "CONFIRMED_RELEASE" && milestone.status !== "SETTLEMENT_PENDING") {
    return {
      ok: false,
      code: "INVALID_STATE",
      reason:
        "Milestone cannot be settled — advertiser confirmation is required first.",
    };
  }

  const obligation = await prisma.financialObligation.findUnique({
    where: { agreementId: milestone.agreementId },
    select: {
      id: true,
      status: true,
      escrowFunded: true,
      dispute: true,
      currency: true,
    },
  });

  if (!obligation) {
    return {
      ok: false,
      code: "OBLIGATION_NOT_FOUND",
      reason: "No financial obligation exists for this agreement.",
    };
  }

  // The unfunded-milestone gate: provider-verified escrow or nothing.
  if (!obligation.escrowFunded) {
    return {
      ok: false,
      code: "FUNDING_MISSING",
      reason:
        "The agreement's funding has not been provider-verified, so nothing can be released.",
    };
  }

  // A disputed/frozen obligation can never settle (13A freeze overlay holds).
  if (obligation.dispute) {
    return {
      ok: false,
      code: "FUNDING_MISSING",
      reason:
        "The agreement's funds are under a dispute freeze; settlement is blocked.",
    };
  }

  // Currency discipline: milestone and obligation must agree.
  if (obligation.currency !== milestone.currency) {
    return {
      ok: false,
      code: "SETTLEMENT_FAILED",
      reason: "Milestone and obligation currencies do not match.",
    };
  }

  const now = new Date();

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1. → SETTLEMENT_PENDING (conditional; the database is the arbiter
      // against concurrent/duplicate confirmations). Accepts an already-
      // settled-pending row from the support decision path.
      const claimed = await tx.milestone.updateMany({
        where: {
          id: milestoneId,
          status: { in: ["CONFIRMED_RELEASE", "SETTLEMENT_PENDING"] },
        },
        data: { status: "SETTLEMENT_PENDING" },
      });

      if (claimed.count === 0) {
        const current = await tx.milestone.findUnique({
          where: { id: milestoneId },
          select: { status: true },
        });

        if (current?.status === "RELEASED") {
          return { replay: true as const, ledgerEntryCount: 0 };
        }

        throw new SettlementRefusedError(
          current
            ? `Milestone moved to ${current.status} concurrently.`
            : "Milestone not found.",
        );
      }

      // 2. Earned ledger lines (13A discipline; idempotent keys). The
      // creator's compensation is settled on paper here; actual provider
      // payout execution stays behind the Stage 13A port.
      const ledgerLines = [
        {
          account: `creator:${milestone.creatorId}:receivable`,
          direction: "CREDIT" as const,
          amountMinor: milestone.creatorAmountMinor,
          currency: milestone.currency,
          entryType: "CREATOR_PAYOUT" as const,
        },
        {
          account: "platform:revenue",
          direction: "CREDIT" as const,
          amountMinor: milestone.advertiserServiceFeeMinor,
          currency: milestone.currency,
          entryType: "PLATFORM_FEE" as const,
        },
        {
          account: "platform:creator-commission",
          direction: "CREDIT" as const,
          amountMinor: milestone.creatorCommissionMinor,
          currency: milestone.currency,
          entryType: "PLATFORM_FEE" as const,
        },
        {
          account: "platform:escrow",
          direction: "DEBIT" as const,
          amountMinor:
            milestone.creatorAmountMinor +
            milestone.advertiserServiceFeeMinor +
            milestone.creatorCommissionMinor,
          currency: milestone.currency,
          entryType: "ESCROW_HOLD" as const,
        },
      ];

      const baseKey = `msettle:${milestoneId}`;

      for (const line of ledgerLines) {
        await tx.ledgerEntry.create({
          data: {
            account: line.account,
            direction: line.direction,
            amountMinor: line.amountMinor,
            currency: line.currency,
            entryType: line.entryType,
            agreementId: milestone.agreementId,
            financialObligationId: obligation.id,
            idempotencyKey: `${baseKey}:${line.entryType}:${line.account}`,
            metadata: {
              milestoneRef: milestone.milestoneRef,
              position: milestone.position,
              kind: "milestone_settlement",
            },
          },
        });
      }

      // 3. Milestone audit events (idempotent keys).
      await tx.milestoneEvent.createMany({
        data: [
          {
            milestoneId,
            agreementId: milestone.agreementId,
            eventType: "settlement_requested" as const,
            actor: actor.role,
            actorId: actor.actorId,
            source: actor.source,
            details: { from: "CONFIRMED_RELEASE", to: "SETTLEMENT_PENDING" },
            idempotencyKey: `mevt:${milestoneId}:settlement_requested`,
          },
          {
            milestoneId,
            agreementId: milestone.agreementId,
            eventType: "released" as const,
            actor: actor.role,
            actorId: actor.actorId,
            source: actor.source,
            details: {
              creatorAmountMinor: milestone.creatorAmountMinor.toString(),
              advertiserServiceFeeMinor: milestone.advertiserServiceFeeMinor.toString(),
              creatorCommissionMinor: milestone.creatorCommissionMinor.toString(),
              advertiserTotalMinor: milestone.advertiserTotalMinor.toString(),
              currency: milestone.currency,
            },
            idempotencyKey: `mevt:${milestoneId}:released`,
          },
        ],
      });

      // 4. Milestone → RELEASED (conditional again).
      const finalized = await tx.milestone.updateMany({
        where: { id: milestoneId, status: "SETTLEMENT_PENDING" },
        data: { status: "RELEASED", releasedAt: now },
      });

      if (finalized.count === 0) {
        throw new SettlementRefusedError("Milestone moved during settlement.");
      }

      return { replay: false as const, ledgerEntryCount: ledgerLines.length };
    });

    if (result.replay) {
      return {
        ok: true,
        milestoneId,
        status: "RELEASED",
        idempotentReplay: true,
        ledgerEntryCount: 0,
        obligationStatus: obligation.status,
      };
    }

    // 5. Drive the underlying obligation through its own 13A state machine so
    // both lifecycles agree. For single-milestone agreements the obligation
    // is fully consumed; multi-milestone agreements keep the obligation FUNDED
    // for the remaining milestones (the milestone rows are the per-part
    // ledger; the obligation's final release happens with the last one).
    await transitionObligation({
      obligationId: obligation.id,
      from: "FUNDED",
      to: "SETTLEMENT_PENDING",
      cause: "settlement_requested",
      actor: "SYSTEM",
      actorId: null,
      source: "milestone-settlement",
      idempotencyKey: `milestone-${transitionEventKey(obligation.id, "settlement_requested")}:${milestoneId}`,
    }).catch(() => undefined);

    await transitionObligation({
      obligationId: obligation.id,
      from: "SETTLEMENT_PENDING",
      to: "RELEASED",
      cause: "settlement_completed",
      actor: "SYSTEM",
      source: "milestone-settlement",
      idempotencyKey: `milestone-${transitionEventKey(obligation.id, "settlement_completed")}:${milestoneId}`,
    }).catch(() => undefined);

    // Stage 14C: kick off the creator payout for this released milestone.
    // Fire-and-forget with full failure capture inside the payout service —
    // a missing recipient or a provider outage must NEVER fail or roll back
    // the settlement itself; reconciliation's catch-up sweeps unpaid
    // RELEASED milestones until every payout has been resolved.
    const { initiateMilestonePayout } = await import("@/services/payments/payout.service");

    void initiateMilestonePayout(milestoneId).catch((payoutError) => {
      console.error(`post-settlement payout initiation failed for ${milestoneId}`, payoutError);
    });

    return {
      ok: true,
      milestoneId,
      status: "RELEASED",
      idempotentReplay: false,
      ledgerEntryCount: result.ledgerEntryCount,
      obligationStatus: "RELEASED",
    };
  } catch (error) {
    if (error instanceof SettlementRefusedError) {
      return { ok: false, code: "INVALID_STATE", reason: error.message };
    }

    console.error("settleConfirmedMilestone failed", error);

    return {
      ok: false,
      code: "SETTLEMENT_FAILED",
      reason: "Could not settle the milestone.",
    };
  }
}

/** Thrown inside the settlement transaction to roll back a refused step. */
class SettlementRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementRefusedError";
  }
}
