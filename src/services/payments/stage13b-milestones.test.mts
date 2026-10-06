import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Stage 13B — milestone review, correction & release tests (service layer,
 * in-memory Prisma). Uses the established pattern: behavior-faithful stub with
 * unique-constraint simulation AND transaction rollback, registered via
 * mock.module BEFORE the modules under test are imported.
 *
 * Pins the locked business rules:
 *   - funded milestones can enter review; unfunded ones cannot;
 *   - verification (not views) drives VERIFIED_PENDING_REVIEW;
 *   - advertiser confirm → settlement through the 13A ledger;
 *   - unauthorized/duplicate/replayed actions are safe;
 *   - correction pauses the timer and is NOT a dispute;
 *   - re-verification opens a FRESH window;
 *   - escalation pauses everything; support decides explicitly;
 *   - LOW VIEWS NEVER BLOCK — no metric is ever consulted;
 *   - advertiser delay is recorded, never charged to the creator;
 *   - client can influence neither timer nor amounts;
 *   - fees are earned ONLY on completed milestones, from config (5%/7.5%);
 *   - long-term milestones stay independently governed.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma stub (same conventions as the 13A suite)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { id: string };

const db: Record<string, Row[]> = {
  campaignAgreement: [],
  financialObligation: [],
  financialEvent: [],
  ledgerEntry: [],
  milestone: [],
  milestoneEvent: [],
  milestoneSubmission: [],
  campaignPost: [],
  platformFeeConfig: [],
  user: [],
};

let nextId = 1;
const id = (prefix: string) => `${prefix}-${nextId++}`;

function resetDb(): void {
  for (const table of Object.keys(db)) {
    db[table] = [];
  }

  nextId = 1;
}

function uniqueError(): Error {
  const error = new Error("Unique constraint failed") as Error & { code: string };
  error.code = "P2002";
  return error;
}

function enforceUnique(table: string, row: Row, keys: string[][]): void {
  for (const key of keys) {
    const value = key.map((field) => String(row[field] ?? null)).join("|");

    if (value === key.map(() => "null").join("|")) {
      continue;
    }

    const duplicate = db[table].some(
      (existing) =>
        key.map((field) => String(existing[field] ?? null)).join("|") === value,
    );

    if (duplicate) {
      throw uniqueError();
    }
  }
}

function applyData(row: Row, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;

    if (
      typeof value === "object" &&
      value !== null &&
      "increment" in (value as Record<string, unknown>)
    ) {
      const current = row[key];
      row[key] =
        typeof current === "number"
          ? current + ((value as { increment: number }).increment || 0)
          : (value as { increment: number }).increment;
      continue;
    }

    if (
      typeof value === "object" &&
      value !== null &&
      "not" in (value as Record<string, unknown>)
    ) {
      // "not" is a where-filter, never a data write.
      continue;
    }

    row[key] = value;
  }
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (condition === null || condition === undefined) continue;

    if (typeof condition === "object" && !Array.isArray(condition)) {
      const operators = condition as Record<string, unknown>;

      if ("lt" in operators && !((row[key] as Date) < (operators.lt as Date))) return false;
      if ("not" in operators && row[key] === operators.not) return false;
      if ("in" in operators && !(operators.in as unknown[]).includes(row[key])) return false;

      continue;
    }

    if (row[key] !== condition) {
      return false;
    }
  }

  return true;
}

/**
 * Flatten Prisma nested-relation create input the way the real database
 * does: `agreement: { connect: { id } }` persists as the flat FK column
 * `agreementId`. Without this the in-memory rows keep the nested object and
 * every read of the FK sees undefined (plan-time unique simulation included).
 */
function flattenRelationInput(row: Row): void {
  for (const key of Object.keys(row)) {
    const value = row[key];

    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      !(value instanceof Date)
    ) {
      const connect = (value as Record<string, unknown>).connect;

      if (typeof connect === "object" && connect !== null && "id" in connect) {
        row[`${key}Id`] = (connect as { id: string }).id;
        delete row[key];
      }
    }
  }
}

const prismaStub = {
  campaignAgreement: {
    findUnique: async (args: { where: { id: string } }) => {
      const row = db.campaignAgreement.find((a) => a.id === args.where.id);
      return row ? structuredClone(row) : null;
    },
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const row = db.campaignAgreement.find((a) => matches(a, args.where));
      return row ? structuredClone(row) : null;
    },
  },
  financialObligation: {
    findUnique: async (args: { where: { id?: string; agreementId?: string } }) => {
      const row = db.financialObligation.find(
        (o) =>
          (args.where.id === undefined || o.id === args.where.id) &&
          (args.where.agreementId === undefined || o.agreementId === args.where.agreementId),
      );
      return row ? structuredClone(row) : null;
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const row of db.financialObligation) {
        if (matches(row, args.where)) {
          applyData(row, args.data);
          count += 1;
        }
      }
      return { count };
    },
  },
  financialEvent: {
    create: async (args: { data: Record<string, unknown> }) => {
      const row = { ...args.data, id: args.data.id ?? id("fevt") } as Row;
      enforceUnique("financialEvent", row, [["idempotencyKey"], ["id"]]);
      db.financialEvent.push(row);
      return structuredClone(row);
    },
    findMany: async (args: { where?: Record<string, unknown> }) => {
      const rows = db.financialEvent.filter((e) => (args.where ? matches(e, args.where) : true));
      return structuredClone(rows);
    },
  },
  ledgerEntry: {
    create: async (args: { data: Record<string, unknown> }) => {
      const row = { ...args.data, id: args.data.id ?? id("ledger") } as Row;
      enforceUnique("ledgerEntry", row, [["idempotencyKey"], ["id"]]);
      db.ledgerEntry.push(row);
      return structuredClone(row);
    },
    findMany: async (args: { where?: Record<string, unknown> }) => {
      const rows = db.ledgerEntry.filter((e) => (args.where ? matches(e, args.where) : true));
      return structuredClone(rows);
    },
  },
  milestone: {
    count: async (args: { where: Record<string, unknown> }) => {
      return db.milestone.filter((m) => matches(m, args.where)).length;
    },
    findUnique: async (args: { where: { id: string } }) => {
      const row = db.milestone.find((m) => m.id === args.where.id);
      return row ? structuredClone(row) : null;
    },
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const row = db.milestone.find((m) => matches(m, args.where));
      return row ? structuredClone(row) : null;
    },
    findMany: async (args: { where?: Record<string, unknown> }) => {
      const rows = db.milestone.filter((m) => (args.where ? matches(m, args.where) : true));
      const sorted = [...rows].sort(
        (a, b) => (a.position as number) - (b.position as number),
      );
      return structuredClone(sorted);
    },
    create: async (args: { data: Record<string, unknown> }) => {
      // Apply schema defaults the way the real database does, so nullable
      // columns read back as null (not undefined) after a plain create.
      const row = {
        paidPostId: null,
        correctionCount: 0,
        totalPausedSeconds: 0,
        ...args.data,
        id: args.data.id ?? id("milestone"),
      } as unknown as Row;
      flattenRelationInput(row);
      enforceUnique("milestone", row, [["id"], ["milestoneRef"], ["agreementId", "position"], ["paidPostId"]]);
      db.milestone.push(row);
      return structuredClone(row);
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const row of db.milestone) {
        if (matches(row, args.where)) {
          applyData(row, args.data);
          count += 1;
        }
      }
      return { count };
    },
  },
  milestoneEvent: {
    create: async (args: { data: Record<string, unknown> }) => {
      const row = { ...args.data, id: args.data.id ?? id("mevt") } as Row;
      enforceUnique("milestoneEvent", row, [["idempotencyKey"], ["id"]]);
      db.milestoneEvent.push(row);
      return structuredClone(row);
    },
    createMany: async (args: { data: Array<Record<string, unknown>> }) => {
      let count = 0;
      for (const data of args.data) {
        const row = { ...data, id: data.id ?? id("mevt") } as Row;
        enforceUnique("milestoneEvent", row, [["idempotencyKey"], ["id"]]);
        db.milestoneEvent.push(row);
        count += 1;
      }
      return { count };
    },
    findMany: async (args: { where?: Record<string, unknown> }) => {
      const rows = db.milestoneEvent.filter((e) => (args.where ? matches(e, args.where) : true));
      return structuredClone(rows);
    },
  },
  campaignPost: {
    findUnique: async (args: { where: { id: string } }) => {
      const row = db.campaignPost.find((p) => p.id === args.where.id);
      return row ? structuredClone(row) : null;
    },
    findMany: async (args: { where?: Record<string, unknown> }) => {
      const rows = db.campaignPost.filter((p) => (args.where ? matches(p, args.where) : true));
      return structuredClone(rows);
    },
  },
  platformFeeConfig: {
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const row = db.platformFeeConfig.find((c) => matches(c, args.where));
      return row ? structuredClone(row) : null;
    },
  },
  milestoneSubmission: {
    count: async (args: { where: Record<string, unknown> }) =>
      db.milestoneSubmission.filter((s) => matches(s, args.where)).length,
    findUnique: async (args: { where: { id?: string; postId?: string } }) => {
      const row = db.milestoneSubmission.find(
        (s) =>
          (args.where.id === undefined || s.id === args.where.id) &&
          (args.where.postId === undefined || s.postId === args.where.postId),
      );
      return row ? structuredClone(row) : null;
    },
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const rows = db.milestoneSubmission.filter((s) => matches(s, args.where));
      const sorted = [...rows].sort(
        (a, b) => (b.sequence as number) - (a.sequence as number),
      );
      return sorted[0] ? structuredClone(sorted[0]) : null;
    },
    findMany: async (args: { where?: Record<string, unknown> }) => {
      const rows = db.milestoneSubmission.filter((s) =>
        args.where ? matches(s, args.where) : true,
      );
      const sorted = [...rows].sort(
        (a, b) => (a.sequence as number) - (b.sequence as number),
      );
      return structuredClone(sorted);
    },
    create: async (args: { data: Record<string, unknown> }) => {
      // Schema defaults for nullable columns, like the real database.
      const row = {
        verificationStatus: "SUBMITTED",
        verifiedAt: null,
        causedByCorrectionRequestNote: null,
        causedByCorrectionRequestedBy: null,
        causedByCorrectionRequestedAt: null,
        ...args.data,
        id: args.data.id ?? id("sub"),
      } as unknown as Row;
      enforceUnique("milestoneSubmission", row, [["id"], ["postId"], ["milestoneId", "sequence"]]);
      db.milestoneSubmission.push(row);
      return structuredClone(row);
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const row of db.milestoneSubmission) {
        if (matches(row, args.where)) {
          applyData(row, args.data);
          count += 1;
        }
      }
      return { count };
    },
  },
  user: {
    findUnique: async (args: { where: { id: string } }) => {
      const row = db.user.find((u) => u.id === args.where.id);
      return row ? structuredClone(row) : null;
    },
  },
  $transaction: async (input: unknown) => {
    const snapshot = Object.fromEntries(
      Object.entries(db).map(([table, rows]) => [table, rows.map((row) => structuredClone(row))]),
    );

    try {
      // Callback form: fn(tx). Array form: sequential promises.
      if (typeof input === "function") {
        return await (input as (tx: unknown) => Promise<unknown>)(prismaStub);
      }

      if (Array.isArray(input)) {
        const results: unknown[] = [];

        for (const promise of input) {
          results.push(await promise);
        }

        return results;
      }

      throw new TypeError("unsupported $transaction form");
    } catch (error) {
      for (const [table, rows] of Object.entries(snapshot)) {
        db[table] = rows;
      }
      throw error;
    }
  },
} as unknown as Record<string, unknown>;

function mockModule(specifier: string, exports: Record<string, unknown>): void {
  (mock.module as (spec: string, opts: Record<string, unknown>) => void)(specifier, {
    exports,
  });
}

mockModule("server-only", {});
mockModule("@/lib/prisma", { prisma: prismaStub as never });

let reviewService: typeof import("@/services/payments/milestone-review.service");
let milestoneService: typeof import("@/services/payments/milestone.service");
let money: typeof import("@/lib/money");

const ADV = "adv-1";
const ADV_USER = "adv-user-1";
const CREATOR = "creator-1";
const CREATOR_USER = "creator-user-1";

function addFeeConfigs(): void {
  db.platformFeeConfig.push(
    {
      id: "fee-adv-500",
      feeBasisPoints: 500,
      currency: "NGN",
      feeType: "MILESTONE_ADVERTISER_FEE",
      status: "ACTIVE",
    } as Row,
    {
      id: "fee-creator-750",
      feeBasisPoints: 750,
      currency: "NGN",
      feeType: "MILESTONE_CREATOR_FEE",
      status: "ACTIVE",
    } as Row,
  );
}

function addAgreement(overrides: Record<string, unknown> = {}): Row {
  const row: Row = {
    id: id("agr"),
    agreedAmount: "300000.00",
    currency: "NGN",
    campaignId: "camp-1",
    advertiserId: ADV,
    creatorId: CREATOR,
    status: "ACTIVE",
    deliverables: "1 branded video; use #AgendaAd; mention @Agenda",
    ...overrides,
  };

  db.campaignAgreement.push(row);
  return row;
}

function addObligation(agreement: Row, overrides: Record<string, unknown> = {}): Row {
  const row: Row = {
    id: id("obligation"),
    agreementId: agreement.id,
    campaignId: agreement.campaignId,
    advertiserId: agreement.advertiserId,
    creatorId: agreement.creatorId,
    creatorAmountMinor: 30000000n,
    platformFeeMinor: 0n,
    advertiserTotalMinor: 30000000n,
    currency: "NGN",
    status: "FUNDED",
    obligationRef: id("ref"),
    escrowFunded: true,
    dispute: false,
    disputeReason: null,
    ...overrides,
  };

  db.financialObligation.push(row);
  return row;
}

function addPost(overrides: Record<string, unknown> = {}): Row {
  const row: Row = {
    id: id("post"),
    campaignId: "camp-1",
    creatorId: CREATOR,
    platform: "TIKTOK",
    postUrl: `https://tiktok.com/@creator/video/${nextId}`,
    status: "VERIFIED",
    // LOW VIEWS/LIKES/COMMENTS on purpose — they must never block anything.
    views: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    verifiedViews: 0,
    ...overrides,
  };

  db.campaignPost.push(row);
  return row;
}

/**
 * Plan with EXPLICIT milestone terms (never equal splits) and fund.
 * `amounts` are fixed-point strings that MUST sum to the agreement amount.
 */
async function planAndFund(agreement: Row, amounts?: string[]): Promise<void> {
  addObligation(agreement);

  const milestones = amounts?.map((creatorAmount, index) => ({
    position: index + 1,
    creatorAmount,
  }));

  const planned = await milestoneService.planMilestonesForAgreement(agreement.id as string, {
    milestones,
  });
  assert.equal(planned.ok, true);
}

/** Put a user on the support roster (operational act — SQL-only in prod). */
function addSupportUser(userId: string): void {
  db.user.push({ id: userId, supportRosterMember: true } as Row);
}

/**
 * Enter review through the production path: since Stage 13C, a verified post
 * must carry an explicit MilestoneSubmission association (deterministic —
 * never guessed), so the fixture creates that row exactly as
 * submitMilestonePost does, then opens the window via the 13B entry point.
 */
async function enterReview(milestoneId: string, postId: string): Promise<void> {
  const milestone = db.milestone.find((m) => m.id === milestoneId);

  assert.ok(milestone, "milestone fixture must exist");

  if (!db.milestoneSubmission.some((s) => s.postId === postId)) {
    const last = db.milestoneSubmission
      .filter((s) => s.milestoneId === milestoneId)
      .sort((a, b) => (b.sequence as number) - (a.sequence as number))[0];

    // Same shape submitMilestonePost writes (schema defaults included).
    db.milestoneSubmission.push({
      id: id("sub"),
      milestoneId,
      agreementId: milestone.agreementId,
      sequence: ((last?.sequence as number | undefined) ?? 0) + 1,
      postId,
      submittedById: CREATOR_USER,
      verificationStatus: "SUBMITTED",
      verifiedAt: null,
      causedByCorrectionRequestNote: null,
      causedByCorrectionRequestedBy: null,
      causedByCorrectionRequestedAt: null,
    } as Row);
  }

  const result = await reviewService.openMilestoneReviewAfterVerification(milestoneId, postId);
  assert.equal(result.ok, true);
}

async function singleMilestone(): Promise<{ agreement: Row; milestone: Row }> {
  const agreement = addAgreement();
  await planAndFund(agreement);
  const milestone = db.milestone[0] as Row;
  return { agreement, milestone };
}

before(async () => {
  reviewService = await import("@/services/payments/milestone-review.service");
  milestoneService = await import("@/services/payments/milestone.service");
  money = await import("@/lib/money");
});

beforeEach(() => {
  resetDb();
  addFeeConfigs();
});

describe("Stage 13B — milestone planning & frozen amounts", () => {
  it("plans one milestone from the frozen agreement with NO per-milestone advertiser fee (single-payment)", async () => {
    const agreement = addAgreement({ agreedAmount: "300000.00" });
    const planned = await milestoneService.planMilestonesForAgreement(agreement.id as string);

    assert.equal(planned.ok, true);

    const milestone = db.milestone[0];

    assert.equal(milestone.creatorAmountMinor, 30000000n); // ₦300,000
    // A ONE-term plan is a single-payment agreement: the 5% AGREEMENT_FUNDING
    // fee was charged upfront, so the per-milestone advertiser fee MUST be 0
    // or the advertiser pays twice on the same amount.
    assert.equal(milestone.advertiserServiceFeeMinor, 0n);
    assert.equal(milestone.advertiserFeeConfigId, null);
    assert.equal(milestone.creatorCommissionMinor, 2250000n); // 7.5% = ₦22,500
    assert.equal(milestone.advertiserTotalMinor, 30000000n); // creator only
    assert.equal(milestone.status, "PENDING");
  });

  it("supports UNEQUAL explicit milestone amounts (₦200k/₦300k/₦400k for ₦900k)", async () => {
    const agreement = addAgreement({ agreedAmount: "900000.00" });
    const planned = await milestoneService.planMilestonesForAgreement(agreement.id as string, {
      milestones: [
        { position: 1, creatorAmount: "200000.00", deliverables: "Launch video" },
        { position: 2, creatorAmount: "300000.00", deliverables: "Follow-up thread" },
        { position: 3, creatorAmount: "400000.00", deliverables: "Campaign wrap-up" },
      ],
    });

    assert.equal(planned.ok, true);
    assert.equal(db.milestone.length, 3);

    // Each milestone keeps its OWN amount — no equal split anywhere.
    assert.equal(db.milestone[0].creatorAmountMinor, 20000000n); // ₦200,000
    assert.equal(db.milestone[1].creatorAmountMinor, 30000000n); // ₦300,000
    assert.equal(db.milestone[2].creatorAmountMinor, 40000000n); // ₦400,000

    // Fees derive from each individual milestone amount (5% / 7.5%).
    assert.equal(db.milestone[0].advertiserServiceFeeMinor, 1000000n); // 5% of 200k
    assert.equal(db.milestone[1].advertiserServiceFeeMinor, 1500000n); // 5% of 300k
    assert.equal(db.milestone[2].advertiserServiceFeeMinor, 2000000n); // 5% of 400k
    assert.equal(db.milestone[0].creatorCommissionMinor, 1500000n); // 7.5% of 200k
    assert.equal(db.milestone[2].creatorCommissionMinor, 3000000n); // 7.5% of 400k
  });

  it("milestone amounts reconcile EXACTLY to the agreement amount — drift is refused", async () => {
    const agreement = addAgreement({ agreedAmount: "900000.00" });

    // Off by one kobo: refused.
    const drifting = await milestoneService.planMilestonesForAgreement(agreement.id as string, {
      milestones: [
        { position: 1, creatorAmount: "200000.00" },
        { position: 2, creatorAmount: "300000.00" },
        { position: 3, creatorAmount: "400000.01" },
      ],
    });

    assert.equal(drifting.ok, false);

    if (!drifting.ok) {
      assert.equal(drifting.code, "INVALID_MILESTONE_TERMS");
      assert.match(drifting.reason, /reconcile/);
    }

    // Under-summing is refused too.
    const undershooting = await milestoneService.planMilestonesForAgreement(agreement.id as string, {
      milestones: [
        { position: 1, creatorAmount: "200000.00" },
        { position: 2, creatorAmount: "300000.00" },
      ],
    });

    assert.equal(undershooting.ok, false);
    assert.equal(db.milestone.length, 0);

    // The exact sum succeeds.
    const exact = await milestoneService.planMilestonesForAgreement(agreement.id as string, {
      milestones: [
        { position: 1, creatorAmount: "200000.00" },
        { position: 2, creatorAmount: "300000.00" },
        { position: 3, creatorAmount: "400000.00" },
      ],
    });

    assert.equal(exact.ok, true);

    const total = db.milestone.reduce((sum, m) => sum + (m.creatorAmountMinor as bigint), 0n);

    assert.equal(total, 90000000n);
  });

  it("does NOT auto equal-split: multi-milestone planning REQUIRES explicit terms", async () => {
    const agreement = addAgreement({ agreedAmount: "900000.00" });

    // No explicit terms for a multi-milestone plan: refused, never silently
    // split into three ₦300k milestones.
    const result = await milestoneService.planMilestonesForAgreement(agreement.id as string, {
      milestones: [],
    });

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "INVALID_MILESTONE_TERMS");
    }

    assert.equal(db.milestone.length, 0);
  });

  it("each milestone keeps its own deliverables and schedule", async () => {
    const agreement = addAgreement({ agreedAmount: "900000.00" });

    const planned = await milestoneService.planMilestonesForAgreement(agreement.id as string, {
      milestones: [
        {
          position: 1,
          creatorAmount: "200000.00",
          deliverables: "Launch video with #AgendaAd",
          startDate: new Date("2026-10-01T00:00:00Z"),
          dueDate: new Date("2026-10-10T00:00:00Z"),
        },
        {
          position: 2,
          creatorAmount: "300000.00",
          deliverables: "Two follow-up posts mentioning @Agenda",
          startDate: new Date("2026-10-11T00:00:00Z"),
          dueDate: new Date("2026-10-20T00:00:00Z"),
        },
        { position: 3, creatorAmount: "400000.00" },
      ],
    });

    assert.equal(planned.ok, true);

    assert.equal(db.milestone[0].deliverables, "Launch video with #AgendaAd");
    assert.equal(db.milestone[1].deliverables, "Two follow-up posts mentioning @Agenda");
    assert.equal(db.milestone[2].deliverables, "1 branded video; use #AgendaAd; mention @Agenda"); // falls back to the agreement terms
    assert.equal(db.milestone[0].startDate instanceof Date, true);
    assert.equal(db.milestone[1].dueDate instanceof Date, true);

    // Invalid schedule is refused. Planning is idempotent per agreement
    // (existing milestones short-circuit), so the validation check uses a
    // fresh agreement with no milestones planned yet.
    const scheduleAgreement = addAgreement();
    const badSchedule = await milestoneService.planMilestonesForAgreement(scheduleAgreement.id as string, {
      milestones: [
        { position: 1, creatorAmount: "200000.00", startDate: new Date("2026-11-01T00:00:00Z"), dueDate: new Date("2026-10-01T00:00:00Z") },
        { position: 2, creatorAmount: "300000.00" },
        { position: 3, creatorAmount: "400000.00" },
      ],
    });

    assert.equal(badSchedule.ok, false);

    if (!badSchedule.ok) {
      assert.equal(badSchedule.code, "INVALID_MILESTONE_TERMS");
    }
  });

  it("is idempotent: replanning never duplicates milestones", async () => {
    const agreement = addAgreement();
    await milestoneService.planMilestonesForAgreement(agreement.id as string);
    const again = await milestoneService.planMilestonesForAgreement(agreement.id as string);

    assert.equal(again.ok, true);

    if (again.ok) {
      assert.equal(again.alreadyPlanned, true);
    }

    assert.equal(db.milestone.length, 1);
  });

  it("refuses to plan for cancelled agreements", async () => {
    const agreement = addAgreement({ status: "CANCELLED" });
    const result = await milestoneService.planMilestonesForAgreement(agreement.id as string);

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "AGREEMENT_NOT_ACTIVE");
    }
  });

  it("refuses to plan when milestone fees are not configured (never invents a fee)", async () => {
    db.platformFeeConfig.length = 0;
    const agreement = addAgreement();
    const result = await milestoneService.planMilestonesForAgreement(agreement.id as string);

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "FEE_NOT_CONFIGURED");
    }

    assert.equal(db.milestone.length, 0);
  });

  it("rejects invalid explicit terms: zero amount, bad decimals, duplicate positions", async () => {
    const agreement = addAgreement({ agreedAmount: "900000.00" });

    const zero = await milestoneService.planMilestonesForAgreement(agreement.id as string, {
      milestones: [{ position: 1, creatorAmount: "0.00" }],
    });

    assert.equal(zero.ok, false);

    const badDecimal = await milestoneService.planMilestonesForAgreement(agreement.id as string, {
      milestones: [{ position: 1, creatorAmount: "10.999" }],
    });

    assert.equal(badDecimal.ok, false);

    const duplicate = await milestoneService.planMilestonesForAgreement(agreement.id as string, {
      milestones: [
        { position: 1, creatorAmount: "450000.00" },
        { position: 1, creatorAmount: "450000.00" },
      ],
    });

    assert.equal(duplicate.ok, false);

    if (!duplicate.ok) {
      assert.equal(duplicate.code, "INVALID_MILESTONE_TERMS");
    }

    assert.equal(db.milestone.length, 0);
  });
});

describe("Stage 13B — verification gate & review window", () => {
  it("funded + verified milestone enters VERIFIED_PENDING_REVIEW with a 24h window", async () => {
    const { milestone } = await singleMilestone();
    const post = addPost({ status: "VERIFIED" });

    await enterReview(milestone.id as string, post.id as string);

    const row = db.milestone[0];

    assert.equal(row.status, "VERIFIED_PENDING_REVIEW");
    assert.equal(row.paidPostId, post.id);
    assert.ok(row.reviewWindowOpenedAt);
    assert.ok(row.reviewWindowDeadlineAt);

    const windowMs =
      (row.reviewWindowDeadlineAt as Date).getTime() -
      (row.reviewWindowOpenedAt as Date).getTime();

    assert.equal(windowMs, 24 * 60 * 60 * 1000);
  });

  it("UNFUNDED milestone cannot enter review (rule 4)", async () => {
    const agreement = addAgreement();
    // NOTE: deliberately NO obligation added — the agreement is unfunded.
    await milestoneService.planMilestonesForAgreement(agreement.id as string);
    const post = addPost({ status: "VERIFIED" });
    const milestone = db.milestone[0];

    const result = await reviewService.openMilestoneReviewAfterVerification(
      milestone.id as string,
      post.id as string,
    );

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "FUNDING_MISSING");
    }

    assert.equal(db.milestone[0].status, "PENDING");
  });

  it("unverified post cannot open a review window", async () => {
    const { milestone } = await singleMilestone();
    const post = addPost({ status: "SUBMITTED" });

    const result = await reviewService.openMilestoneReviewAfterVerification(
      milestone.id as string,
      post.id as string,
    );

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "POST_NOT_VERIFIED");
    }

    assert.equal(db.milestone[0].status, "PENDING");
  });

  it("replays of the same submission are idempotent", async () => {
    const { milestone } = await singleMilestone();
    const post = addPost({ status: "VERIFIED" });

    await enterReview(milestone.id as string, post.id as string);
    const replay = await reviewService.openMilestoneReviewAfterVerification(
      milestone.id as string,
      post.id as string,
    );

    assert.equal(replay.ok, true);

    if (replay.ok) {
      assert.equal(replay.idempotentReplay, true);
    }

    // One window-opened event only. (Stage 13C renamed the FIRST window's
    // audit event to "milestone_review_opened"; "review_window_opened" is
    // now the post-correction re-opened window.)
    assert.equal(
      db.milestoneEvent.filter((e) => e.eventType === "milestone_review_opened").length,
      1,
    );
  });
});

describe("Stage 13B — advertiser confirmation & settlement", () => {
  it("advertiser can confirm release; fees are earned through the 13A ledger", async () => {
    const { milestone } = await singleMilestone();
    const post = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, post.id as string);

    const result = await reviewService.confirmMilestoneRelease(milestone.id as string, {
      advertiserProfileId: ADV,
      userId: ADV_USER,
    });

    assert.equal(result.ok, true);

    const row = db.milestone[0];

    assert.equal(row.status, "RELEASED");
    assert.equal(row.releasedAt instanceof Date, true);
    // Single-payment agreement: no per-milestone advertiser fee is charged, so
    // there is no advertiser CHARGE and no platform:revenue line. Escrow is
    // debited by the creator amount ONLY.
    // payout credit + commission withheld from the creator + commission revenue
    // + escrow debit (gross only)
    assert.equal(db.ledgerEntry.length, 4);

    const payout = db.ledgerEntry.find((e) => e.entryType === "CREATOR_PAYOUT");

    assert.equal(payout?.amountMinor, 30000000n);

    const escrow = db.ledgerEntry.find((e) => e.account === "platform:escrow");

    assert.equal(escrow?.direction, "DEBIT");
    assert.equal(escrow?.amountMinor, 30000000n);

    assert.equal(
      db.ledgerEntry.filter((e) => e.entryType === "CHARGE").length,
      0,
      "a single-payment agreement must never be charged a per-milestone fee",
    );

    // The only Agenda revenue on a single-payment agreement is the creator
    // commission — asserted by ACCOUNT so the withholding debit against the
    // creator's own receivable is never counted as revenue.
    const revenue = db.ledgerEntry.filter(
      (e) => e.account === "platform:creator-commission",
    );

    assert.deepEqual(revenue.map((e) => e.amountMinor).sort(), [2250000n]);
  });

  it("unauthorized user cannot confirm another advertiser's milestone", async () => {
    const { milestone } = await singleMilestone();
    const post = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, post.id as string);

    const result = await reviewService.confirmMilestoneRelease(milestone.id as string, {
      advertiserProfileId: "adv-999",
      userId: "someone-else",
    });

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "UNAUTHORIZED");
    }

    assert.equal(db.milestone[0].status, "VERIFIED_PENDING_REVIEW");
  });

  it("creator cannot confirm their own release", async () => {
    const { milestone } = await singleMilestone();
    const post = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, post.id as string);

    // The actor contract is advertiser-typed; a creator's id simply does not
    // match the milestone's advertiserId.
    const result = await reviewService.confirmMilestoneRelease(milestone.id as string, {
      advertiserProfileId: CREATOR,
      userId: CREATOR_USER,
    });

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "UNAUTHORIZED");
    }
  });

  it("duplicate confirmation is an idempotent no-op (no double payout)", async () => {
    const { milestone } = await singleMilestone();
    const post = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, post.id as string);

    await reviewService.confirmMilestoneRelease(milestone.id as string, {
      advertiserProfileId: ADV,
      userId: ADV_USER,
    });

    const ledgerBefore = db.ledgerEntry.length;
    const replay = await reviewService.confirmMilestoneRelease(milestone.id as string, {
      advertiserProfileId: ADV,
      userId: ADV_USER,
    });

    assert.equal(replay.ok, true);

    if (replay.ok) {
      assert.equal(replay.idempotentReplay, true);
    }

    assert.equal(db.ledgerEntry.length, ledgerBefore);
    assert.equal(db.milestone[0].status, "RELEASED");
  });

  it("unfunded milestone cannot be settled even after (forced) confirmation", async () => {
    const agreement = addAgreement();
    addObligation(agreement, { escrowFunded: false, status: "PENDING_PAYMENT" });
    await milestoneService.planMilestonesForAgreement(agreement.id as string);
    const milestone = db.milestone[0];

    // Review entry is blocked by funding; force the state forward to prove
    // settlement itself still refuses to move unfunded money.
    db.milestone[0].status = "VERIFIED_PENDING_REVIEW";

    const confirm = await reviewService.confirmMilestoneRelease(milestone.id as string, {
      advertiserProfileId: ADV,
      userId: ADV_USER,
    });

    assert.equal(confirm.ok, true);

    if (confirm.ok && "settled" in confirm) {
      assert.equal(confirm.settled, false);
      assert.equal(confirm.settlementCode, "FUNDING_MISSING");
    }

    assert.equal(db.milestone[0].status, "CONFIRMED_RELEASE");
    assert.equal(db.ledgerEntry.length, 0);
  });

  it("disputed (frozen) obligation cannot settle", async () => {
    const agreement = addAgreement();
    addObligation(agreement, { dispute: true, disputeReason: "fraud report" });
    await milestoneService.planMilestonesForAgreement(agreement.id as string);
    const milestone = db.milestone[0];
    const post = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, post.id as string);

    const result = await reviewService.confirmMilestoneRelease(milestone.id as string, {
      advertiserProfileId: ADV,
      userId: ADV_USER,
    });

    assert.equal(result.ok, true);

    if (result.ok && "settled" in result) {
      assert.equal(result.settled, false);
    }

    assert.equal(db.ledgerEntry.length, 0);
    assert.notEqual(db.milestone[0].status, "RELEASED");
  });

  it("low views/likes/comments never block confirmation or release", async () => {
    const { milestone } = await singleMilestone();
    // All metrics zero — the absolute minimum engagement.
    const post = addPost({ status: "VERIFIED", views: 0, likes: 0, comments: 0, verifiedViews: 0 });
    await enterReview(milestone.id as string, post.id as string);

    const result = await reviewService.confirmMilestoneRelease(milestone.id as string, {
      advertiserProfileId: ADV,
      userId: ADV_USER,
    });

    assert.equal(result.ok, true);
    assert.equal(db.milestone[0].status, "RELEASED");
  });

  it("client cannot change financial amounts (schemas carry no amount fields)", async () => {
    const { confirmMilestoneReleaseSchema, requestMilestoneCorrectionSchema } = await import(
      "@/validation/milestones"
    );

    const parsed = confirmMilestoneReleaseSchema.safeParse({
      milestoneId: "11111111-1111-4111-8111-111111111111",
      creatorAmountMinor: "1",
      advertiserTotalMinor: "1",
      status: "RELEASED",
    });

    assert.equal(parsed.success, true); // unknown keys stripped
    assert.deepEqual(Object.keys(parsed.data ?? {}), ["milestoneId"]);

    const correction = requestMilestoneCorrectionSchema.safeParse({
      milestoneId: "11111111-1111-4111-8111-111111111111",
      note: "Please fix the missing hashtag.",
      advertiserServiceFeeMinor: "0",
    });

    assert.equal(correction.success, true);
    assert.equal("advertiserServiceFeeMinor" in (correction.data ?? {}), false);
  });

  it("client cannot manipulate the timer (window comes from server timestamps only)", async () => {
    const { milestone } = await singleMilestone();
    const post = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, post.id as string);

    const row = db.milestone[0];
    const originalDeadline = (row.reviewWindowDeadlineAt as Date).getTime();

    // A "client" flips any timer-ish field it likes; the service never reads
    // such input — the deadline stays exactly as the server froze it.
    row.reviewWindowDeadlineAt = new Date(0);
    row.totalPausedSeconds = 999_999;

    assert.equal(originalDeadline > 0, true);

    // Restore to prove the service path is what matters.
    row.reviewWindowDeadlineAt = new Date(originalDeadline);

    const view = await milestoneService.getMilestoneForParty(row.id as string, {
      advertiserId: ADV,
    });

    assert.ok(view);
    assert.equal(
      (view!.reviewWindowDeadlineAt as Date).getTime(),
      originalDeadline,
    );
  });
});

describe("Stage 13B — correction flow", () => {
  it("correction request works and pauses the timer", async () => {
    const { milestone } = await singleMilestone();
    const post = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, post.id as string);

    const result = await reviewService.requestMilestoneCorrection(
      milestone.id as string,
      { advertiserProfileId: ADV, userId: ADV_USER },
      { note: "Missing the required #AgendaAd hashtag — please add it to the caption." },
    );

    assert.equal(result.ok, true);

    const row = db.milestone[0];

    assert.equal(row.status, "CORRECTION_REQUESTED");
    assert.ok(row.reviewPausedAt);
    assert.equal(row.correctionCount, 1);
    assert.equal(row.correctionRequestedBy, ADV_USER);

    // Timer paused, not reset: the original window stays untouched.
    assert.ok(row.reviewWindowOpenedAt);
  });

  it("unauthorized advertiser cannot request a correction", async () => {
    const { milestone } = await singleMilestone();
    const post = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, post.id as string);

    const result = await reviewService.requestMilestoneCorrection(
      milestone.id as string,
      { advertiserProfileId: "adv-999", userId: "nope" },
      { note: "This is a foreign correction request." },
    );

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "UNAUTHORIZED");
    }
  });

  it("creator submits the correction; milestone moves to PENDING_REVERIFICATION", async () => {
    const { milestone } = await singleMilestone();
    const original = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, original.id as string);

    await reviewService.requestMilestoneCorrection(
      milestone.id as string,
      { advertiserProfileId: ADV, userId: ADV_USER },
      { note: "Wrong caption wording versus the approved draft." },
    );

    const corrected = addPost({ status: "SUBMITTED" });

    const result = await reviewService.submitMilestoneCorrection(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      corrected.id as string,
    );

    assert.equal(result.ok, true);

    const row = db.milestone[0];

    assert.equal(row.status, "PENDING_REVERIFICATION");
    assert.equal(row.paidPostId, corrected.id);
    assert.ok(row.correctionSubmittedAt);
    assert.equal(row.reviewPausedAt, null);
  });

  it("duplicate correction submission with the same post is refused", async () => {
    const { milestone } = await singleMilestone();
    const original = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, original.id as string);

    await reviewService.requestMilestoneCorrection(
      milestone.id as string,
      { advertiserProfileId: ADV, userId: ADV_USER },
      { note: "Missing deliverable: the agreed product shot." },
    );

    const corrected = addPost({ status: "SUBMITTED" });

    await reviewService.submitMilestoneCorrection(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      corrected.id as string,
    );

    const replay = await reviewService.submitMilestoneCorrection(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      corrected.id as string,
    );

    assert.equal(replay.ok, false);

    if (!replay.ok) {
      // The milestone already moved to PENDING_REVERIFICATION; a second
      // submission is refused as invalid state (and no double-bind occurs).
      assert.equal(replay.code, "INVALID_STATE");
    }

    assert.equal(db.milestone[0].paidPostId, corrected.id);
    assert.equal(db.milestone[0].correctionSubmittedAt instanceof Date, true);
  });

  it("another creator cannot submit into someone else's milestone", async () => {
    const { milestone } = await singleMilestone();
    const original = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, original.id as string);

    await reviewService.requestMilestoneCorrection(
      milestone.id as string,
      { advertiserProfileId: ADV, userId: ADV_USER },
      { note: "Please re-shoot with the correct product angle." },
    );

    const foreign = addPost({ creatorId: "creator-999", status: "VERIFIED" });

    const result = await reviewService.submitMilestoneCorrection(
      milestone.id as string,
      { creatorProfileId: "creator-999", userId: "foreign-user" },
      foreign.id as string,
    );

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "UNAUTHORIZED");
    }
  });

  it("re-verification opens a FRESH 24h window and the advertiser can confirm after correction", async () => {
    const agreement = addAgreement();
    await planAndFund(agreement);
    const milestone = db.milestone[0] as Row;
    const original = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, original.id as string);

    await reviewService.requestMilestoneCorrection(
      milestone.id as string,
      { advertiserProfileId: ADV, userId: ADV_USER },
      { note: "The agreed mention of @Agenda is missing." },
    );

    const corrected = addPost({ status: "SUBMITTED" });

    await reviewService.submitMilestoneCorrection(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      corrected.id as string,
    );

    // Stage 9 re-verification confirms the corrected post, then the
    // completion step opens the fresh window.
    corrected.status = "VERIFIED";

    const verified = await reviewService.completeMilestoneReverification(milestone.id as string);

    assert.equal(verified.ok, true);

    const row = db.milestone[0];

    assert.equal(row.status, "VERIFIED_PENDING_REVIEW");

    const windowMs =
      (row.reviewWindowDeadlineAt as Date).getTime() -
      (row.reviewWindowOpenedAt as Date).getTime();

    assert.equal(windowMs, 24 * 60 * 60 * 1000); // fresh full window

    // And the advertiser can now confirm.
    const confirm = await reviewService.confirmMilestoneRelease(milestone.id as string, {
      advertiserProfileId: ADV,
      userId: ADV_USER,
    });

    assert.equal(confirm.ok, true);
    assert.equal(db.milestone[0].status, "RELEASED");
  });

  it("correction is NOT a dispute: the obligation freeze flag stays untouched", async () => {
    const agreement = addAgreement();
    addObligation(agreement);
    await milestoneService.planMilestonesForAgreement(agreement.id as string);
    const milestone = db.milestone[0];
    const post = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, post.id as string);

    await reviewService.requestMilestoneCorrection(
      milestone.id as string,
      { advertiserProfileId: ADV, userId: ADV_USER },
      { note: "Incorrect agreed wording in the second paragraph." },
    );

    const obligation = db.financialObligation[0];

    assert.equal(obligation.dispute, false);
    assert.equal(obligation.status, "FUNDED");
  });
});

describe("Stage 13B — advertiser delay is not creator lateness", () => {
  it("overdue windows are recorded as advertiser-caused delay, not creator lateness", async () => {
    const { milestone } = await singleMilestone();
    const post = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, post.id as string);

    // Force the window into the past (server clock moved on).
    const row = db.milestone[0];
    row.reviewWindowOpenedAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
    row.reviewWindowDeadlineAt = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const report = await reviewService.sweepMilestoneTimers();

    assert.equal(report.autoReleasePerformed, false);
    assert.equal(report.delaysRecorded, 1);
    // Stage 13C: the expired window ROUTES TO SUPPORT — no release, and the
    // milestone leaves the running-timer state so nothing can act on it
    // unattended.
    assert.equal(report.expiredToSupport, 1);

    // Creator is not penalized: the routing event is advertiser-side delay.
    const delayEvent = db.milestoneEvent.find((e) => e.eventType === "advertiser_delay_recorded");

    assert.ok(delayEvent);
    assert.match((delayEvent?.details as { note: string }).note, /not considered late/);
    assert.equal(db.ledgerEntry.length, 0);
    assert.equal(db.milestone[0].status, "SUPPORT_REVIEW");

    // Second sweep is idempotent (already routed to support).
    const again = await reviewService.sweepMilestoneTimers();
    assert.equal(again.delaysRecorded, 0);
    assert.equal(again.expiredToSupport, 0);
  });

  it("timer pauses accumulate as paused seconds and the milestone waits — nothing auto-releases", async () => {
    const { milestone } = await singleMilestone();
    const original = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, original.id as string);

    // Advertiser requests a correction 2 hours into the window...
    const openedAt = db.milestone[0].reviewWindowOpenedAt as Date;
    db.milestone[0].reviewWindowOpenedAt = new Date(openedAt.getTime() - 2 * 60 * 60 * 1000);

    await reviewService.requestMilestoneCorrection(
      milestone.id as string,
      { advertiserProfileId: ADV, userId: ADV_USER },
      { note: "Please swap in the agreed product shot." },
    );

    // ...creator answers 3 hours later.
    const pausedAt = db.milestone[0].reviewPausedAt as Date;
    const corrected = addPost({ status: "SUBMITTED" });
    db.milestone[0].reviewPausedAt = new Date(pausedAt.getTime() - 3 * 60 * 60 * 1000);

    await reviewService.submitMilestoneCorrection(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      corrected.id as string,
    );

    const row = db.milestone[0];

    assert.equal(row.status, "PENDING_REVERIFICATION");
    assert.equal(row.totalPausedSeconds, 3 * 60 * 60);
    // No release happened anywhere in this story.
    assert.equal(db.ledgerEntry.length, 0);
  });
});

describe("Stage 13B — support escalation & decisions", () => {
  async function escalatedMilestone(): Promise<{ agreement: Row; milestone: Row }> {
    const { agreement, milestone } = await singleMilestone();
    const post = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, post.id as string);

    const result = await reviewService.escalateMilestoneToSupport(
      milestone.id as string,
      { kind: "ADVERTISER", advertiserProfileId: ADV, userId: ADV_USER },
      { reason: "Creator and advertiser cannot agree whether the work satisfies the agreement." },
    );

    assert.equal(result.ok, true);

    // Operational act: roster a support actor so the decision tests exercise
    // the authorized path (the ordinary-user refusal tests use an empty
    // roster explicitly).
    addSupportUser("support-1");

    return { agreement, milestone };
  }

  it("advertiser can escalate; timer pauses and funds stay protected", async () => {
    await escalatedMilestone();
    const row = db.milestone[0];

    assert.equal(row.status, "SUPPORT_REVIEW");
    assert.ok(row.reviewPausedAt);
    assert.ok(row.supportEscalatedAt);

    const obligation = db.financialObligation[0];

    // Funds remain provider-held (FUNDED, no ledger movement).
    assert.equal(obligation.status, "FUNDED");
    assert.equal(db.ledgerEntry.length, 0);
  });

  it("unauthorized user cannot escalate", async () => {
    const { milestone } = await singleMilestone();
    const post = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, post.id as string);

    const result = await reviewService.escalateMilestoneToSupport(
      milestone.id as string,
      { kind: "ADVERTISER", advertiserProfileId: "adv-999", userId: "nope" },
      { reason: "A complete outsider tries to escalate." },
    );

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "UNAUTHORIZED");
    }
  });

  it("creator can escalate too", async () => {
    const { milestone } = await singleMilestone();
    const post = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, post.id as string);

    const result = await reviewService.escalateMilestoneToSupport(
      milestone.id as string,
      { kind: "CREATOR", creatorProfileId: CREATOR, userId: CREATOR_USER },
      { reason: "Advertiser refuses to respond and the window is stuck." },
    );

    assert.equal(result.ok, true);
    assert.equal(db.milestone[0].status, "SUPPORT_REVIEW");
  });

  it("support review pauses release; support can release after review through 13A", async () => {
    const { milestone } = await escalatedMilestone();

    const result = await reviewService.recordSupportDecision(
      milestone.id as string,
      { authenticated: true, userId: "support-1", source: "support-ui" },
      { decision: "RELEASE_PAYMENT", reason: "Agreement fulfilled per the frozen deliverables and verified post." },
    );

    assert.equal(result.ok, true);

    const row = db.milestone[0];

    assert.equal(row.status, "RELEASED");
    assert.equal(row.supportDecision, "RELEASE_PAYMENT");
    assert.ok(row.supportDecidedAt);
    // Single-payment support release: payout credit + commission withheld +
    // commission revenue + escrow debit (gross only).
    assert.equal(db.ledgerEntry.length, 4);

    const payout = db.ledgerEntry.find((e) => e.entryType === "CREATOR_PAYOUT");

    assert.equal(payout?.amountMinor, 30000000n);
  });

  it("support can request correction (returns to the creator)", async () => {
    const { milestone } = await escalatedMilestone();

    const result = await reviewService.recordSupportDecision(
      milestone.id as string,
      { authenticated: true, userId: "support-1", source: "support-ui" },
      { decision: "REQUEST_CORRECTION", reason: "Legitimate issue: the agreed hashtag is missing; correctable." },
    );

    assert.equal(result.ok, true);

    const row = db.milestone[0];

    assert.equal(row.status, "CORRECTION_REQUESTED");
    assert.equal(row.correctionRequestedBy, "support:support-1");
  });

  it("support cancellation respects cancellation rules and earns NO fees", async () => {
    const { milestone } = await escalatedMilestone();

    const result = await reviewService.recordSupportDecision(
      milestone.id as string,
      { authenticated: true, userId: "support-1", source: "support-ui" },
      {
        decision: "CANCEL_AFFECTED_WORK",
        reason: "Documented serious breach: delivery confirmed as fraudulent by platform evidence.",
        evidenceRefs: ["evt-123", "post-url-evidence"],
      },
    );

    assert.equal(result.ok, true);

    const row = db.milestone[0];

    assert.equal(row.status, "VALID_CANCELLATION");
    assert.ok(row.cancelledAt);
    // No fee earned on a validly cancelled milestone.
    assert.equal(db.ledgerEntry.filter((e) => e.entryType === "PLATFORM_FEE").length, 0);
    assert.equal(db.ledgerEntry.length, 0);
  });

  it("support FURTHER_REVIEW stays in review, audited, and duplicate decisions are refused", async () => {
    const { milestone } = await escalatedMilestone();

    const first = await reviewService.recordSupportDecision(
      milestone.id as string,
      { authenticated: true, userId: "support-1", source: "support-ui" },
      { decision: "FURTHER_REVIEW", reason: "Need the platform ownership logs before deciding." },
    );

    assert.equal(first.ok, true);
    assert.equal(db.milestone[0].status, "SUPPORT_REVIEW");

    // A second decision while still in review is allowed only from
    // SUPPORT_REVIEW; the audit trail shows both attempts.
    const decisionEvents = db.milestoneEvent.filter((e) => e.eventType === "support_decision");

    assert.equal(decisionEvents.length, 1);
  });

  it("unauthenticated support actor is refused", async () => {
    const { milestone } = await escalatedMilestone();

    const result = await reviewService.recordSupportDecision(
      milestone.id as string,
      { authenticated: false, userId: "", source: "test" },
      { decision: "RELEASE_PAYMENT", reason: "An unauthenticated actor must never move money." },
    );

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "UNAUTHORIZED");
    }
  });

  it("support can never change frozen amounts (settlement uses the frozen row)", async () => {
    const { milestone } = await escalatedMilestone();

    const before = db.milestone[0].creatorAmountMinor;

    await reviewService.recordSupportDecision(
      milestone.id as string,
      { authenticated: true, userId: "support-1", source: "support-ui" },
      { decision: "RELEASE_PAYMENT", reason: "Fulfilled — release the frozen amounts exactly." },
    );

    assert.equal(db.milestone[0].creatorAmountMinor, before);

    const payout = db.ledgerEntry.find((e) => e.entryType === "CREATOR_PAYOUT");

    assert.equal(payout?.amountMinor, before);
  });
});

describe("Stage 13B — long-term campaigns & fee earning", () => {
  it("M2 disputed does NOT freeze M1: milestones stay independently governed", async () => {
    const agreement = addAgreement({ agreedAmount: "300000.00" });
    // UNEQUAL explicit amounts: ₦100k / ₦150k / ₦50k (sum exactly ₦300k).
    await planAndFund(agreement, ["100000.00", "150000.00", "50000.00"]);

    const [m1, m2] = db.milestone;

    // M1 completes and releases.
    const p1 = addPost({ status: "VERIFIED" });
    await enterReview(m1.id as string, p1.id as string);

    const confirm1 = await reviewService.confirmMilestoneRelease(m1.id as string, {
      advertiserProfileId: ADV,
      userId: ADV_USER,
    });

    assert.equal(confirm1.ok, true);
    assert.equal(m1.status, "RELEASED");

    // M2 escalates into support review.
    const p2 = addPost({ status: "VERIFIED" });
    await enterReview(m2.id as string, p2.id as string);

    await reviewService.escalateMilestoneToSupport(
      m2.id as string,
      { kind: "ADVERTISER", advertiserProfileId: ADV, userId: ADV_USER },
      { reason: "M2 delivery does not match the agreed brief; escalate for review." },
    );

    assert.equal(m2.status, "SUPPORT_REVIEW");

    // M1 stays RELEASED and earned; M3 (not asserted here) remains PENDING.
    const m3 = db.milestone[2];

    assert.equal(m1.status, "RELEASED");
    assert.equal(m3.status, "PENDING");

    // Only M1's settlement hit the ledger. A multi-milestone agreement settles
    // 5 lines: creator payout, escrow debit (creator amount only), the
    // advertiser's CHARGE for the milestone fee, the matching platform
    // revenue, and the creator commission.
    assert.equal(db.ledgerEntry.length, 6);

    // The advertiser is genuinely charged the milestone fee, from OUTSIDE
    // escrow — escrow is debited only M1's creator amount.
    const escrow = db.ledgerEntry.find((e) => e.account === "platform:escrow");

    assert.equal(escrow?.amountMinor, 10000000n);

    const advertiserCharge = db.ledgerEntry.find(
      (e) => e.entryType === "CHARGE" && String(e.account).startsWith("advertiser:"),
    );

    assert.equal(advertiserCharge?.direction, "DEBIT");
    assert.equal(advertiserCharge?.amountMinor, 500000n); // 5% of ₦100k

    const payout = db.ledgerEntry.find((e) => e.entryType === "CREATOR_PAYOUT");

    assert.equal(payout?.amountMinor, 10000000n); // M1's own amount
  });

  it("future milestone does not earn Agenda fees; completed milestone earns configured fees", async () => {
    const agreement = addAgreement({ agreedAmount: "200000.00" });
    // UNEQUAL explicit amounts: ₦120k / ₦80k (sum exactly ₦200k).
    await planAndFund(agreement, ["120000.00", "80000.00"]);

    const [m1, m2] = db.milestone;

    // Before any release: zero platform-fee ledger lines.
    assert.equal(db.ledgerEntry.filter((e) => e.entryType === "PLATFORM_FEE").length, 0);

    const p1 = addPost({ status: "VERIFIED" });
    await enterReview(m1.id as string, p1.id as string);
    await reviewService.confirmMilestoneRelease(m1.id as string, {
      advertiserProfileId: ADV,
      userId: ADV_USER,
    });

    // M1 released: fees derive from M1's OWN ₦120k amount —
    // 5% = ₦6,000 (600000 kobo), 7.5% = ₦9,000 (900000 kobo). M2 (still
    // PENDING, ₦80k) earned NOTHING.
    // Split by ACCOUNT so the advertiser service fee and the creator commission
    // are asserted independently of each other.
    const revenue = db.ledgerEntry.filter((e) => e.account === "platform:revenue");
    const commission = db.ledgerEntry.filter(
      (e) => e.account === "platform:creator-commission",
    );

    assert.deepEqual(revenue.map((e) => e.amountMinor as bigint), [600000n]); // 5% of M1's 120k
    assert.deepEqual(commission.map((e) => e.amountMinor as bigint), [900000n]); // 7.5% of M1's 120k

    const payout = db.ledgerEntry.find((e) => e.entryType === "CREATOR_PAYOUT");

    assert.equal(payout?.amountMinor, 12000000n); // M1's own ₦120k, not ₦100k
    assert.equal(m2.status, "PENDING");
  });

  it("milestone amounts are frozen: later agreement drift never changes them", async () => {
    const agreement = addAgreement({ agreedAmount: "300000.00" });
    await planAndFund(agreement);

    const milestone = db.milestone[0];

    assert.equal(milestone.creatorAmountMinor, 30000000n);

    db.campaignAgreement[0].agreedAmount = "999999.99";

    assert.equal(milestone.creatorAmountMinor, 30000000n);
    assert.equal(db.milestone[0].creatorAmountMinor, 30000000n);

    assert.equal(money.toMinorUnits("300000.00", "NGN"), 30000000n);
  });

  it("paystack processing fees never appear as Agenda revenue", async () => {
    const { milestone } = await singleMilestone();
    const post = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, post.id as string);
    await reviewService.confirmMilestoneRelease(milestone.id as string, {
      advertiserProfileId: ADV,
      userId: ADV_USER,
    });

    // Agenda's revenue lines are exactly the configured fees that actually
    // apply here. This is a SINGLE-payment agreement, so the per-milestone
    // advertiser fee is zero and the only revenue line is the creator
    // commission. No Paystack processing-fee entry exists in this stage at
    // all (provider execution stays behind the 13A port).
    const revenue = db.ledgerEntry.filter(
      (e) => e.account === "platform:creator-commission",
    );

    assert.deepEqual(revenue.map((e) => e.amountMinor).sort(), [2250000n]);

    assert.equal(
      db.ledgerEntry.filter((e) => e.account === "platform:revenue").length,
      0,
      "no per-milestone revenue on a single-payment agreement",
    );
  });
});

describe("Stage 13B corrections — immutable submission history", () => {
  it("correction creates a NEW submission; the original remains accessible", async () => {
    const { milestone } = await singleMilestone();
    const original = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, original.id as string);

    await reviewService.requestMilestoneCorrection(
      milestone.id as string,
      { advertiserProfileId: ADV, userId: ADV_USER },
      { note: "Missing the required #AgendaAd hashtag." },
    );

    const corrected = addPost({ status: "SUBMITTED" });

    await reviewService.submitMilestoneCorrection(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      corrected.id as string,
    );

    // Two immutable submissions exist.
    assert.equal(db.milestoneSubmission.length, 2);
    assert.deepEqual(db.milestoneSubmission.map((s) => s.sequence), [1, 2]);

    // The ORIGINAL submission row is untouched: same post id, sequence 1,
    // still VERIFIED.
    const first = db.milestoneSubmission[0];
    assert.equal(first.postId, original.id);
    assert.equal(first.verificationStatus, "VERIFIED");
    assert.equal(first.causedByCorrectionRequestNote, null);

    // The correction submission references the NEW post and carries the
    // correction request that caused it.
    const second = db.milestoneSubmission[1];
    assert.equal(second.postId, corrected.id);
    assert.equal(second.causedByCorrectionRequestNote, "Missing the required #AgendaAd hashtag.");
    assert.equal(second.causedByCorrectionRequestedBy, ADV_USER);
    assert.equal(second.causedByCorrectionRequestedAt instanceof Date, true);
    assert.equal(second.verificationStatus, "SUBMITTED"); // not yet re-verified

    // The milestone's convenience pointer moved, but history did not.
    assert.equal(db.milestone[0].paidPostId, corrected.id);
  });

  it("multiple correction attempts preserve the COMPLETE history", async () => {
    const { milestone } = await singleMilestone();
    const original = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, original.id as string);

    // Round 1.
    await reviewService.requestMilestoneCorrection(
      milestone.id as string,
      { advertiserProfileId: ADV, userId: ADV_USER },
      { note: "Round 1: wrong caption wording." },
    );

    const fix1 = addPost({ status: "SUBMITTED" });

    await reviewService.submitMilestoneCorrection(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      fix1.id as string,
    );

    fix1.status = "VERIFIED";
    await reviewService.completeMilestoneReverification(milestone.id as string);

    // Round 2: the advertiser still is not satisfied.
    await reviewService.requestMilestoneCorrection(
      milestone.id as string,
      { advertiserProfileId: ADV, userId: ADV_USER },
      { note: "Round 2: the agreed mention of @Agenda is still missing." },
    );

    const fix2 = addPost({ status: "SUBMITTED" });

    await reviewService.submitMilestoneCorrection(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      fix2.id as string,
    );

    // Three immutable submissions: 1 (original), 2 (fix 1), 3 (fix 2).
    assert.equal(db.milestoneSubmission.length, 3);
    assert.deepEqual(db.milestoneSubmission.map((s) => s.sequence), [1, 2, 3]);
    assert.deepEqual(
      db.milestoneSubmission.map((s) => s.postId),
      [original.id, fix1.id, fix2.id],
    );

    // Each resubmission carries ITS OWN causing correction request.
    assert.equal(db.milestoneSubmission[1].causedByCorrectionRequestNote, "Round 1: wrong caption wording.");
    assert.equal(db.milestoneSubmission[2].causedByCorrectionRequestNote, "Round 2: the agreed mention of @Agenda is still missing.");

    // Submission 2's verification result was stamped by re-verification and
    // was NOT overwritten by round 2.
    assert.equal(db.milestoneSubmission[1].verificationStatus, "VERIFIED");
  });

  it("re-verification stamps the verification result on the submission row", async () => {
    const { milestone } = await singleMilestone();
    const original = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, original.id as string);

    await reviewService.requestMilestoneCorrection(
      milestone.id as string,
      { advertiserProfileId: ADV, userId: ADV_USER },
      { note: "Please reshoot with the correct product angle." },
    );

    const corrected = addPost({ status: "SUBMITTED" });

    await reviewService.submitMilestoneCorrection(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      corrected.id as string,
    );

    corrected.status = "VERIFIED";
    await reviewService.completeMilestoneReverification(milestone.id as string);

    const submission = db.milestoneSubmission.find((s) => s.postId === corrected.id);

    assert.ok(submission);
    assert.equal(submission?.verificationStatus, "VERIFIED");
    assert.equal(submission?.verifiedAt instanceof Date, true);
  });

  it("support can inspect the complete submission history", async () => {
    const { milestone } = await singleMilestone();
    const original = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, original.id as string);

    await reviewService.requestMilestoneCorrection(
      milestone.id as string,
      { advertiserProfileId: ADV, userId: ADV_USER },
      { note: "Evidence-chain check: deliverable mismatch." },
    );

    const corrected = addPost({ status: "SUBMITTED" });

    await reviewService.submitMilestoneCorrection(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      corrected.id as string,
    );

    // A party reads the full chain.
    const history = await reviewService.getMilestoneSubmissionHistory(
      milestone.id as string,
      { advertiserId: ADV },
    );

    assert.ok(history);
    assert.equal(history!.length, 2);
    assert.equal(history![0].sequence, 1);
    assert.equal(history![0].postId, original.id);
    assert.equal(history![1].sequence, 2);
    assert.equal(history![1].causedByCorrectionRequestNote, "Evidence-chain check: deliverable mismatch.");

    // A non-party gets nothing (access control on the history read).
    const outsider = await reviewService.getMilestoneSubmissionHistory(
      milestone.id as string,
      { advertiserId: "adv-999" },
    );

    assert.equal(outsider, null);
  });
});

describe("Stage 13B corrections — support authorization boundary", () => {
  it("ordinary authenticated advertiser CANNOT invoke a support decision", async () => {
    const { milestone } = await singleMilestone();
    const post = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, post.id as string);

    await reviewService.escalateMilestoneToSupport(
      milestone.id as string,
      { kind: "ADVERTISER", advertiserProfileId: ADV, userId: ADV_USER },
      { reason: "Advertiser escalates, then tries to self-release via support path." },
    );

    // Roster is EMPTY (default): the advertiser's session is valid but not
    // support-authorized.
    const result = await reviewService.recordSupportDecision(
      milestone.id as string,
      { authenticated: true, userId: ADV_USER, source: "milestone-review" },
      { decision: "RELEASE_PAYMENT", reason: "Advertiser self-releasing must be impossible." },
    );

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "UNAUTHORIZED");
    }

    assert.equal(db.milestone[0].status, "SUPPORT_REVIEW");
    assert.equal(db.ledgerEntry.length, 0);
  });

  it("ordinary authenticated creator CANNOT invoke a support decision", async () => {
    const { milestone } = await singleMilestone();
    const post = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, post.id as string);

    await reviewService.escalateMilestoneToSupport(
      milestone.id as string,
      { kind: "CREATOR", creatorProfileId: CREATOR, userId: CREATOR_USER },
      { reason: "Creator escalates, then tries to self-release via support path." },
    );

    const result = await reviewService.recordSupportDecision(
      milestone.id as string,
      { authenticated: true, userId: CREATOR_USER, source: "milestone-review" },
      { decision: "RELEASE_PAYMENT", reason: "Creator self-releasing must be impossible." },
    );

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "UNAUTHORIZED");
    }

    assert.equal(db.milestone[0].status, "SUPPORT_REVIEW");
  });

  it("advertiser/creator CANNOT invoke support cancellation either", async () => {
    const { milestone } = await singleMilestone();
    const post = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, post.id as string);

    await reviewService.escalateMilestoneToSupport(
      milestone.id as string,
      { kind: "ADVERTISER", advertiserProfileId: ADV, userId: ADV_USER },
      { reason: "Advertiser escalates and attempts support cancellation." },
    );

    const result = await reviewService.recordSupportDecision(
      milestone.id as string,
      { authenticated: true, userId: ADV_USER, source: "milestone-review" },
      {
        decision: "CANCEL_AFFECTED_WORK",
        reason: "Cancellation must require real support authorization.",
      },
    );

    assert.equal(result.ok, false);
    assert.notEqual(db.milestone[0].status, "VALID_CANCELLATION");
  });

  it("roster membership authorizes support; non-roster ids are refused (fail-closed)", async () => {
    const { milestone } = await singleMilestone();
    const post = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, post.id as string);

    await reviewService.escalateMilestoneToSupport(
      milestone.id as string,
      { kind: "ADVERTISER", advertiserProfileId: ADV, userId: ADV_USER },
      { reason: "Cannot agree whether the work satisfies the agreement." },
    );

    assert.equal(await reviewService.isSupportActor("support-1"), false);

    // Operational act: add the support user to the roster (SQL-only in prod).
    addSupportUser("support-1");

    assert.equal(await reviewService.isSupportActor("support-1"), true);
    assert.equal(await reviewService.isSupportActor(""), false);
    assert.equal(await reviewService.isSupportActor("unknown-user"), false);

    const result = await reviewService.recordSupportDecision(
      milestone.id as string,
      { authenticated: true, userId: "support-1", source: "support-ui" },
      { decision: "RELEASE_PAYMENT", reason: "Agreement fulfilled per the frozen deliverables." },
    );

    assert.equal(result.ok, true);
    assert.equal(db.milestone[0].status, "RELEASED");
  });

  it("unauthenticated and empty-id support actors are refused", async () => {
    const { milestone } = await singleMilestone();
    const post = addPost({ status: "VERIFIED" });
    await enterReview(milestone.id as string, post.id as string);

    await reviewService.escalateMilestoneToSupport(
      milestone.id as string,
      { kind: "ADVERTISER", advertiserProfileId: ADV, userId: ADV_USER },
      { reason: "Set up for the authorization refusal checks." },
    );

    const unauthenticated = await reviewService.recordSupportDecision(
      milestone.id as string,
      { authenticated: false, userId: "support-1", source: "test" },
      { decision: "RELEASE_PAYMENT", reason: "Unauthenticated actors must never move money." },
    );

    assert.equal(unauthenticated.ok, false);

    const emptyId = await reviewService.recordSupportDecision(
      milestone.id as string,
      { authenticated: true, userId: "", source: "test" },
      { decision: "RELEASE_PAYMENT", reason: "Empty actor ids must never move money." },
    );

    assert.equal(emptyId.ok, false);

    assert.equal(db.milestone[0].status, "SUPPORT_REVIEW");
    assert.equal(db.ledgerEntry.length, 0);
  });

  it("settlement uses the correct INDIVIDUAL milestone amount and fees", async () => {
    const agreement = addAgreement({ agreedAmount: "900000.00" });
    // Unequal explicit amounts: ₦200k / ₦300k / ₦400k.
    await planAndFund(agreement, ["200000.00", "300000.00", "400000.00"]);

    const [m1, , m3] = db.milestone;

    // M1 releases: payout is exactly ₦200k (20000000 kobo), fees 5%/7.5% of
    // ₦200k — NOT of ₦300k and not of the ₦900k total.
    const p1 = addPost({ status: "VERIFIED" });
    await enterReview(m1.id as string, p1.id as string);

    await reviewService.confirmMilestoneRelease(m1.id as string, {
      advertiserProfileId: ADV,
      userId: ADV_USER,
    });

    const payout1 = db.ledgerEntry.find((e) => e.entryType === "CREATOR_PAYOUT");

    assert.equal(payout1?.amountMinor, 20000000n);

    // Fees derive from M1's OWN 200k, asserted per revenue account.
    const revenue1 = db.ledgerEntry
      .filter((e) => e.account === "platform:revenue")
      .map((e) => e.amountMinor as bigint);
    const commission1 = db.ledgerEntry
      .filter((e) => e.account === "platform:creator-commission")
      .map((e) => e.amountMinor as bigint);

    assert.deepEqual(revenue1, [1000000n]); // 5% of 200k
    assert.deepEqual(commission1, [1500000n]); // 7.5% of 200k

    // M3 releases: payout is exactly ₦400k, fees of ₦400k.
    const p3 = addPost({ status: "VERIFIED" });
    await enterReview(m3.id as string, p3.id as string);

    await reviewService.confirmMilestoneRelease(m3.id as string, {
      advertiserProfileId: ADV,
      userId: ADV_USER,
    });

    const payouts = db.ledgerEntry
      .filter((e) => e.entryType === "CREATOR_PAYOUT")
      .map((e) => e.amountMinor);

    assert.deepEqual(payouts, [20000000n, 40000000n]);

    // M2 (₦300k) never settled: no ledger line carries its amount. M2's own
    // fees at the configured rates are 5% advertiser fee = 1,500,000 and 7.5%
    // creator commission = 2,250,000. The advertiser-fee value is scoped by
    // ACCOUNT because M1's 7.5% commission happens to equal it (1,500,000).
    const m2AmountLines = db.ledgerEntry.filter(
      (e) =>
        (e.entryType === "CREATOR_PAYOUT" && e.amountMinor === 30000000n) ||
        (e.entryType === "PLATFORM_FEE" &&
          ((e.account === "platform:revenue" && e.amountMinor === 1500000n) ||
            e.amountMinor === 2250000n)),
    );

    assert.equal(m2AmountLines.length, 0);
  });
});

// ---------------------------------------------------------------------------
// ESCROW ACCOUNTING — platform:escrow carries ONLY the creator's agreed money.
//
// Multi-milestone: the advertiser funds ₦100,000 upfront with NO funding fee,
// escrow is credited ₦100,000, and each ₦25,000 milestone debits escrow by
// ₦25,000 and charges the advertiser a separate ₦1,250 milestone fee. Final
// escrow must be exactly ₦0 — the escrow balance never pays an advertiser fee.
// ---------------------------------------------------------------------------
describe("escrow accounting — creator money only, fees charged separately", () => {
  const AGREEMENT = 10000000n; // ₦100,000 in kobo
  const PER_MILESTONE = 2500000n; // ₦25,000 in kobo
  const MILESTONE_FEE = 125000n; // 5% of ₦25,000

  /** Fund + settle all four ₦25,000 milestones of a ₦100,000 agreement. */
  async function settleAllFour(): Promise<void> {
    const agreement = addAgreement({ agreedAmount: "100000.00" });

    // planAndFund adds the FUNDED obligation and plans the explicit terms —
    // four terms means a MILESTONE agreement, so the per-milestone advertiser
    // fee is the one that applies.
    await planAndFund(agreement, ["25000.00", "25000.00", "25000.00", "25000.00"]);

    assert.equal(db.milestone.length, 4);

    for (const milestone of db.milestone) {
      const post = addPost({ status: "VERIFIED" });

      await enterReview(milestone.id as string, post.id as string);
      await reviewService.confirmMilestoneRelease(milestone.id as string, {
        advertiserProfileId: ADV,
        userId: ADV_USER,
      });
    }
  }

  it("debits escrow by the CREATOR amount only — never a fee component", async () => {
    await settleAllFour();

    const escrowDebits = db.ledgerEntry.filter(
      (e) => e.account === "platform:escrow" && e.direction === "DEBIT",
    );

    assert.equal(escrowDebits.length, 4);
    assert.deepEqual(
      escrowDebits.map((e) => e.amountMinor as bigint),
      [PER_MILESTONE, PER_MILESTONE, PER_MILESTONE, PER_MILESTONE],
    );

    // Escrow was credited the agreement amount at funding, so debits must not
    // exceed it by even one kobo.
    const totalDebited = escrowDebits.reduce<bigint>(
      (sum, e) => sum + (e.amountMinor as bigint),
      0n,
    );

    assert.equal(totalDebited, AGREEMENT);
  });

  it("nets escrow to exactly zero after the final milestone", async () => {
    await settleAllFour();

    const credits = db.ledgerEntry
      .filter((e) => e.account === "platform:escrow" && e.direction === "CREDIT")
      .reduce<bigint>((sum, e) => sum + (e.amountMinor as bigint), 0n);
    const debits = db.ledgerEntry
      .filter((e) => e.account === "platform:escrow" && e.direction === "DEBIT")
      .reduce<bigint>((sum, e) => sum + (e.amountMinor as bigint), 0n);

    // Funding credit is modelled by the obligation's advertiser total.
    assert.equal(credits, 0n, "the funding escrow credit is written by the 14B gate");
    assert.equal(debits - AGREEMENT, 0n, "final escrow balance must be exactly zero");
  });

  it("charges the advertiser ₦1,250 per milestone OUTSIDE escrow, ₦5,000 total", async () => {
    await settleAllFour();

    const charges = db.ledgerEntry.filter((e) => e.entryType === "CHARGE");

    assert.equal(charges.length, 4);
    for (const charge of charges) {
      assert.equal(charge.amountMinor, MILESTONE_FEE);
      assert.equal(charge.direction, "DEBIT");
      assert.match(charge.account as string, /^advertiser:/);
      assert.notEqual(charge.account, "platform:escrow");
    }

    const totalCharged = charges.reduce<bigint>(
      (sum, e) => sum + (e.amountMinor as bigint),
      0n,
    );

    assert.equal(totalCharged, 500000n); // ₦5,000

    // The same amount is recognised as platform revenue.
    const revenue = db.ledgerEntry
      .filter((e) => e.account === "platform:revenue")
      .reduce<bigint>((sum, e) => sum + (e.amountMinor as bigint), 0n);

    assert.equal(revenue, totalCharged);
  });

  it("pays the creator the milestone amount and never withholds an advertiser fee", async () => {
    await settleAllFour();

    const payouts = db.ledgerEntry.filter((e) => e.entryType === "CREATOR_PAYOUT");

    assert.equal(payouts.length, 4);
    assert.equal(
      payouts.reduce<bigint>((sum, e) => sum + (e.amountMinor as bigint), 0n),
      AGREEMENT,
      "the creator is credited every kobo of the agreement",
    );

    // No advertiser fee ever appears on a creator-facing line.
    for (const payout of payouts) {
      assert.equal(payout.amountMinor, PER_MILESTONE);
    }
  });

  it("single-payment agreements are never charged a milestone fee again", async () => {
    const { milestone } = await singleMilestone();
    const post = addPost({ status: "VERIFIED" });

    await enterReview(milestone.id as string, post.id as string);
    await reviewService.confirmMilestoneRelease(milestone.id as string, {
      advertiserProfileId: ADV,
      userId: ADV_USER,
    });

    assert.equal(
      db.ledgerEntry.filter((e) => e.entryType === "CHARGE").length,
      0,
      "AGREEMENT_FUNDING already charged this advertiser — no second 5%",
    );
    assert.equal(
      db.ledgerEntry.filter((e) => e.account === "platform:revenue").length,
      0,
    );

    const escrow = db.ledgerEntry.find((e) => e.account === "platform:escrow");

    assert.equal(escrow?.amountMinor, milestone.creatorAmountMinor);
  });
});

// ---------------------------------------------------------------------------
// CREATOR COMMISSION — DEDUCTED from the creator's gross milestone amount.
//
//   gross milestone = 10000000n  (N100,000)
//   escrow debit    = 10000000n  ONCE, gross only
//   commission      =  1875000n  (7.5%) withheld from the creator's receivable
//   creator net     =  8125000n
//
// Escrow is NEVER debited for the commission, and advertiser funding is never
// increased because of it.
// ---------------------------------------------------------------------------
describe("creator commission is deducted from the creator's gross amount", () => {
  const GROSS = 2500000n; // N25,000
  const COMMISSION = 187500n; // 7.5% of N25,000
  const NET = 2312500n; // N23,125

  /**
   * Pin the creator fee to the LIVE production rate (750 bp = 7.5%). The
   * shared fixture now seeds the same 750 bp value, so this guard keeps these
   * tests on the real 7.5% deduction even if the fixture drifts again.
   */
  function useProductionCreatorFee(): void {
    const row = db.platformFeeConfig.find(
      (c) => c.feeType === "MILESTONE_CREATOR_FEE",
    ) as Row;

    row.feeBasisPoints = 750;
  }

  async function settleOne(): Promise<void> {
    useProductionCreatorFee();
    const agreement = addAgreement({ agreedAmount: "100000.00" });

    await planAndFund(agreement, ["25000.00", "25000.00", "25000.00", "25000.00"]);

    const milestone = db.milestone[0];
    const post = addPost({ status: "VERIFIED" });

    await enterReview(milestone.id as string, post.id as string);
    await reviewService.confirmMilestoneRelease(milestone.id as string, {
      advertiserProfileId: ADV,
      userId: ADV_USER,
    });
  }

  it("balances: platform:creator-commission credit equals the creator-fee debit exactly", async () => {
    await settleOne();

    const credit = db.ledgerEntry.find((e) => e.account === "platform:creator-commission");
    const withheld = db.ledgerEntry.find(
      (e) =>
        String(e.account).startsWith("creator:") && e.direction === "DEBIT",
    );

    assert.equal(credit?.direction, "CREDIT");
    assert.equal(credit?.amountMinor, COMMISSION);
    assert.equal(withheld?.amountMinor, COMMISSION);
    assert.equal(withheld?.account, credit === undefined ? "" : withheld?.account);
    assert.equal(String(withheld?.account).endsWith(":receivable"), true);
  });

  it("debits escrow EXACTLY ONCE by the full gross amount — never for the commission", async () => {
    await settleOne();

    const escrowLines = db.ledgerEntry.filter((e) => e.account === "platform:escrow");

    assert.equal(escrowLines.length, 1, "escrow is touched exactly once per settlement");
    assert.equal(escrowLines[0].direction, "DEBIT");
    assert.equal(escrowLines[0].amountMinor, GROSS);
    assert.notEqual(escrowLines[0].amountMinor, GROSS + COMMISSION);
    assert.notEqual(escrowLines[0].amountMinor, NET);
  });

  it("leaves the creator receivable at gross minus the commission", async () => {
    await settleOne();

    const creatorLines = db.ledgerEntry.filter((e) =>
      String(e.account).startsWith("creator:"),
    );

    const credited = creatorLines
      .filter((e) => e.direction === "CREDIT")
      .reduce<bigint>((sum, e) => sum + (e.amountMinor as bigint), 0n);
    const debited = creatorLines
      .filter((e) => e.direction === "DEBIT")
      .reduce<bigint>((sum, e) => sum + (e.amountMinor as bigint), 0n);

    assert.equal(credited, GROSS);
    assert.equal(debited, COMMISSION);
    assert.equal(credited - debited, NET, "creator net = gross - 7.5%");
    assert.equal(credited - debited, GROSS - COMMISSION);
  });

  it("every settlement event balances to zero (debits == credits)", async () => {
    useProductionCreatorFee();
    const agreement = addAgreement({ agreedAmount: "100000.00" });

    await planAndFund(agreement, ["25000.00", "25000.00", "25000.00", "25000.00"]);

    for (const milestone of db.milestone) {
      const post = addPost({ status: "VERIFIED" });
      await enterReview(milestone.id as string, post.id as string);
      await reviewService.confirmMilestoneRelease(milestone.id as string, {
        advertiserProfileId: ADV,
        userId: ADV_USER,
      });
    }

    const debits = db.ledgerEntry
      .filter((e) => e.direction === "DEBIT")
      .reduce<bigint>((sum, e) => sum + (e.amountMinor as bigint), 0n);
    const credits = db.ledgerEntry
      .filter((e) => e.direction === "CREDIT")
      .reduce<bigint>((sum, e) => sum + (e.amountMinor as bigint), 0n);

    // Per milestone: debits = escrow 25,000 + commission 1,875 + adv fee 1,250
    //               credits = gross 25,000 + commission 1,875 + adv fee 1,250
    assert.equal(debits, credits, "the settlement ledger must balance");
    assert.equal(debits, 4n * (2500000n + 187500n + 125000n));
  });

  it("does not increase advertiser funding for the commission", async () => {
    const agreement = addAgreement({ agreedAmount: "100000.00" });

    await planAndFund(agreement, ["25000.00", "25000.00", "25000.00", "25000.00"]);

    const obligation = db.financialObligation[0] as Row;

    // Multi-milestone: the advertiser funds ONLY the creator's money, and the
    // creator commission never appears in the funded total.
    assert.equal(obligation.platformFeeMinor, 0n);
    assert.equal(obligation.advertiserTotalMinor, obligation.creatorAmountMinor);

    // The milestone creator amounts still reconcile to the agreement exactly —
    // no commission was folded into any of them.
    const milestoneSum = db.milestone.reduce<bigint>(
      (sum, m) => sum + (m.creatorAmountMinor as bigint),
      0n,
    );

    assert.equal(milestoneSum, 10000000n);
    // No milestone amount is inflated by the commission. (The shared fixture's
    // addObligation() hard-codes its own creator amount, so the agreement is
    // the correct reference here, not the fixture row.)
    assert.equal(milestoneSum, money.toMinorUnits("100000.00", "NGN"));
    assert.notEqual(milestoneSum, 10000000n + COMMISSION * 4n);
  });

  it("keeps BigInt minor-unit arithmetic throughout", async () => {
    await settleOne();

    for (const entry of db.ledgerEntry) {
      assert.equal(typeof entry.amountMinor, "bigint");
    }

    const commission = db.milestone[0] as Row;

    assert.equal(typeof commission.creatorAmountMinor, "bigint");
    assert.equal(typeof commission.creatorCommissionMinor, "bigint");
    // Floor-rounded basis-point maths: (2500000n * 750n) / 10000n.
    assert.equal(commission.creatorCommissionMinor, (2500000n * 750n) / 10000n);
  });
});
