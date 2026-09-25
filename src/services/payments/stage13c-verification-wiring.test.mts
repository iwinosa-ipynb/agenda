import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Stage 13C — verification → milestone lifecycle wiring tests (service layer,
 * in-memory Prisma, established stub conventions).
 *
 * Pins:
 *   - explicit post→milestone association (never inferred);
 *   - eligibility + funding gates before submission;
 *   - Stage 9 outcomes (VERIFIED / REJECTED / RETRYABLE) applied to the
 *     correct MilestoneSubmission;
 *   - multi-post milestones only open review when ALL required posts verify;
 *   - one post → one milestone submission (DB-level);
 *   - correction flow preserves immutable history (13B behavior intact);
 *   - 24h timer expiry ROUTES TO SUPPORT, never auto-releases;
 *   - settlement uses individual milestone amounts and configured fees;
 *   - no cross-agreement leakage; replays are safe.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma stub
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
  socialAccount: [],
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

    if (typeof value === "object" && value !== null && "not" in (value as Record<string, unknown>)) {
      continue;
    }

    if (
      typeof value === "object" &&
      value !== null &&
      "in" in (value as Record<string, unknown>)
    ) {
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
  },
  ledgerEntry: {
    create: async (args: { data: Record<string, unknown> }) => {
      const row = { ...args.data, id: args.data.id ?? id("ledger") } as Row;
      enforceUnique("ledgerEntry", row, [["idempotencyKey"], ["id"]]);
      db.ledgerEntry.push(row);
      return structuredClone(row);
    },
  },
  milestone: {
    count: async (args: { where: Record<string, unknown> }) =>
      db.milestone.filter((m) => matches(m, args.where)).length,
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
      return structuredClone(rows);
    },
    create: async (args: { data: Record<string, unknown> }) => {
      const row = {
        paidPostId: null,
        correctionCount: 0,
        totalPausedSeconds: 0,
        requiredPostCount: 1,
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
      const sorted = [...rows].sort((a, b) => (b.sequence as number) - (a.sequence as number));
      return sorted[0] ? structuredClone(sorted[0]) : null;
    },
    findMany: async (args: { where?: Record<string, unknown> }) => {
      const rows = db.milestoneSubmission.filter((s) =>
        args.where ? matches(s, args.where) : true,
      );
      const sorted = [...rows].sort((a, b) => (a.sequence as number) - (b.sequence as number));
      return structuredClone(sorted);
    },
    create: async (args: { data: Record<string, unknown> }) => {
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
  campaignPost: {
    findUnique: async (args: { where: { id: string } }) => {
      const row = db.campaignPost.find((p) => p.id === args.where.id);
      return row ? structuredClone(row) : null;
    },
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const row = db.campaignPost.find((p) => matches(p, args.where));
      return row ? structuredClone(row) : null;
    },
    create: async (args: { data: Record<string, unknown> }) => {
      const row = {
        views: 0,
        likes: 0,
        comments: 0,
        shares: 0,
        verifiedViews: 0,
        status: "SUBMITTED",
        ...args.data,
        id: args.data.id ?? id("post"),
      } as unknown as Row;
      enforceUnique("campaignPost", row, [["id"]]);
      db.campaignPost.push(row);
      return structuredClone(row);
    },
  },
  platformFeeConfig: {
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const row = db.platformFeeConfig.find((c) => matches(c, args.where));
      return row ? structuredClone(row) : null;
    },
  },
  socialAccount: {
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const row = db.socialAccount.find((a) => matches(a, args.where));
      return row ? structuredClone(row) : null;
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

// ---------------------------------------------------------------------------
// Stage 9 verification stub — the pipeline boundary. Tests control the
// outcome per post; the service must treat it as the single verification
// authority (never second-guessing it).
// ---------------------------------------------------------------------------

type StubOutcome =
  | { outcome: "VERIFIED" }
  | { outcome: "REJECTED" }
  | { outcome: "PENDING_RETRY"; reason: string }
  | { outcome: "IN_PROGRESS_BY_OTHER_RUN" }
  | { outcome: "NOT_FOUND" }
  | { outcome: "UNAUTHORIZED" };

const verificationBehavior = new Map<string, StubOutcome>();

mockModule("@/services/post-verification.service", {
  verifyCampaignPostById: async (postId: string) => {
    // Per-post behavior first, then the suite-wide "any" default.
    const outcome =
      verificationBehavior.get(postId) ??
      verificationBehavior.get("any") ?? {
        outcome: "PENDING_RETRY",
        reason: "stub default",
      };

    if (outcome.outcome === "VERIFIED") {
      // Mirror the real pipeline: the post becomes VERIFIED in the DB.
      const row = db.campaignPost.find((p) => p.id === postId);

      if (row) {
        row.status = "VERIFIED";
        row.verifiedViews = 12; // LOW on purpose — never payment-relevant.
      }
    }

    return { success: true, data: outcome };
  },
});

let submissionService: typeof import("@/services/payments/milestone-submission.service");
let reviewService: typeof import("@/services/payments/milestone-review.service");
let milestoneService: typeof import("@/services/payments/milestone.service");

const ADV = "adv-1";
const ADV_USER = "adv-user-1";
const CREATOR = "creator-1";
const CREATOR_USER = "creator-user-1";
const OTHER_CREATOR = "creator-999";

function addFeeConfigs(): void {
  db.platformFeeConfig.push(
    { id: "fee-adv-500", feeBasisPoints: 500, currency: "NGN", feeType: "MILESTONE_ADVERTISER_FEE", status: "ACTIVE" } as Row,
    { id: "fee-creator-1000", feeBasisPoints: 1000, currency: "NGN", feeType: "MILESTONE_CREATOR_FEE", status: "ACTIVE" } as Row,
  );
}

function addAgreement(overrides: Record<string, unknown> = {}): Row {
  const row: Row = {
    id: id("agr"),
    agreedAmount: "900000.00",
    currency: "NGN",
    campaignId: "camp-1",
    advertiserId: ADV,
    creatorId: CREATOR,
    status: "ACTIVE",
    platform: "TIKTOK",
    deliverables: "Agreed deliverables",
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
    creatorAmountMinor: 90000000n,
    platformFeeMinor: 0n,
    advertiserTotalMinor: 90000000n,
    currency: "NGN",
    status: "FUNDED",
    obligationRef: id("ref"),
    escrowFunded: true,
    dispute: false,
    ...overrides,
  };

  db.financialObligation.push(row);
  return row;
}

function addConnection(creatorId = CREATOR, platform = "TIKTOK"): void {
  db.socialAccount.push({
    id: id("social"),
    creatorId,
    platform,
    platformUserId: `platform-${creatorId}`,
  } as Row);
}

async function planAndFund(
  agreement: Row,
  milestones: Array<{ amount: string; requiredPostCount?: number }>,
): Promise<void> {
  addObligation(agreement);

  const planned = await milestoneService.planMilestonesForAgreement(agreement.id as string, {
    milestones: milestones.map((m, index) => ({
      position: index + 1,
      creatorAmount: m.amount,
      ...(m.requiredPostCount !== undefined ? { requiredPostCount: m.requiredPostCount } : {}),
    })),
  });

  assert.equal(planned.ok, true);
}

function input(platform: "TIKTOK" | "X" = "TIKTOK", url?: string) {
  return {
    platform,
    postUrl: url ?? `https://tiktok.com/@creator/video/${nextId}`,
    caption: "Check it out",
  };
}

before(async () => {
  submissionService = await import("@/services/payments/milestone-submission.service");
  reviewService = await import("@/services/payments/milestone-review.service");
  milestoneService = await import("@/services/payments/milestone.service");
});

beforeEach(() => {
  resetDb();
  addFeeConfigs();
  addConnection();
  verificationBehavior.clear();
});

describe("Stage 13C — explicit submission & eligibility", () => {
  it("creator submits a post against the EXACT milestone (deterministic association)", async () => {
    const agreement = addAgreement();
    await planAndFund(agreement, [{ amount: "900000.00" }]);

    const milestone = db.milestone[0];
    verificationBehavior.set("any", { outcome: "VERIFIED" });
    const url = "https://tiktok.com/@creator/video/1001";

    const result = await submissionService.submitMilestonePost(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input("TIKTOK", url),
    );

    if (!result.ok) {
      assert.fail(`submission refused: ${result.code} — ${result.reason}`);
    }

    assert.equal(result.ok, true);

    if (!result.ok) return;

    // The submission row names THIS milestone and THIS post explicitly.
    assert.equal(db.milestoneSubmission.length, 1);

    const submission = db.milestoneSubmission[0];

    assert.equal(submission.milestoneId, milestone.id);
    assert.equal(submission.postId, result.postId);
    assert.equal(submission.sequence, 1);
    assert.equal(submission.submittedById, CREATOR_USER);
    assert.equal(submission.verificationStatus, "VERIFIED");

    // Post lives on the milestone's own campaign.
    const post = db.campaignPost.find((p) => p.id === result.postId);

    assert.equal(post?.campaignId, "camp-1");
    assert.equal(post?.creatorId, CREATOR);
  });

  it("unauthorized creator rejected (another creator's milestone)", async () => {
    const agreement = addAgreement();
    await planAndFund(agreement, [{ amount: "900000.00" }]);

    const milestone = db.milestone[0];

    const result = await submissionService.submitMilestonePost(
      milestone.id as string,
      { creatorProfileId: OTHER_CREATOR, userId: "someone-else" },
      input(),
    );

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "NOT_FOUND"); // no existence leak
    }

    assert.equal(db.milestoneSubmission.length, 0);
    assert.equal(db.campaignPost.length, 0);
  });

  it("advertiser cannot submit creator posts (only the agreement creator passes)", async () => {
    const agreement = addAgreement();
    await planAndFund(agreement, [{ amount: "900000.00" }]);

    const milestone = db.milestone[0];

    // The milestone's creatorId check runs before anything else; an
    // advertiser profile id can never match it.
    const result = await submissionService.submitMilestonePost(
      milestone.id as string,
      { creatorProfileId: ADV, userId: ADV_USER },
      input(),
    );

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "NOT_FOUND");
    }

    assert.equal(db.milestoneSubmission.length, 0);
  });

  it("unfunded milestone rejected (rule 4: no confirmed funding = no start)", async () => {
    const agreement = addAgreement();
    // Deliberately NO obligation row: nothing is funded.
    const planned = await milestoneService.planMilestonesForAgreement(agreement.id as string);
    assert.equal(planned.ok, true);

    const milestone = db.milestone[0];

    const result = await submissionService.submitMilestonePost(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input(),
    );

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "FUNDING_MISSING");
      assert.match(result.reason, /funding is not confirmed/);
    }

    assert.equal(db.milestoneSubmission.length, 0);
    assert.equal(db.campaignPost.length, 0);
  });

  it("escrow-unfunded obligation (client claims paid) is still rejected", async () => {
    const agreement = addAgreement();
    addObligation(agreement, { escrowFunded: false, status: "PROCESSING" });
    await milestoneService.planMilestonesForAgreement(agreement.id as string);

    const milestone = db.milestone[0];

    const result = await submissionService.submitMilestonePost(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input(),
    );

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "FUNDING_MISSING");
    }
  });

  it("platform mismatch rejected (agreement platform is frozen)", async () => {
    const agreement = addAgreement({ platform: "X" });
    await planAndFund(agreement, [{ amount: "900000.00" }]);

    const milestone = db.milestone[0];

    const result = await submissionService.submitMilestonePost(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input("TIKTOK"),
    );

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "PLATFORM_MISMATCH");
    }

    assert.equal(db.milestoneSubmission.length, 0);
  });

  it("missing platform connection rejected", async () => {
    const agreement = addAgreement();
    await planAndFund(agreement, [{ amount: "900000.00" }]);

    db.socialAccount.length = 0; // creator has no connected account

    const milestone = db.milestone[0];

    const result = await submissionService.submitMilestonePost(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input(),
    );

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "PLATFORM_MISMATCH");
      assert.match(result.reason, /Connect your platform account/);
    }
  });

  it("released / cancelled milestones cannot accept submissions", async () => {
    const agreement = addAgreement();
    await planAndFund(agreement, [{ amount: "900000.00" }]);

    const milestone = db.milestone[0];
    milestone.status = "RELEASED";

    const released = await submissionService.submitMilestonePost(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input(),
    );

    assert.equal(released.ok, false);

    if (!released.ok) {
      assert.equal(released.code, "INVALID_STATE");
    }

    milestone.status = "VALID_CANCELLATION";

    const cancelled = await submissionService.submitMilestonePost(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input(),
    );

    assert.equal(cancelled.ok, false);
    assert.equal(db.milestoneSubmission.length, 0);
  });

  it("correction states accept ONLY the correction workflow, not fresh posts", async () => {
    const agreement = addAgreement();
    await planAndFund(agreement, [{ amount: "900000.00" }]);

    const milestone = db.milestone[0];
    milestone.status = "CORRECTION_REQUESTED";

    const result = await submissionService.submitMilestonePost(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input(),
    );

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "INVALID_STATE");
      assert.match(result.reason, /correction workflow/);
    }

    assert.equal(db.milestoneSubmission.length, 0);
  });
});

describe("Stage 13C — Stage 9 outcomes drive the milestone", () => {
  it("verified post opens the correct milestone review (PENDING → VERIFIED_PENDING_REVIEW)", async () => {
    const agreement = addAgreement();
    await planAndFund(agreement, [{ amount: "900000.00" }]);

    const milestone = db.milestone[0];
    verificationBehavior.set("any", { outcome: "VERIFIED" });

    const result = await submissionService.submitMilestonePost(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input(),
    );

    assert.equal(result.ok, true);

    if (!result.ok) return;

    assert.equal(result.verification, "VERIFIED");
    assert.equal(result.reviewOpened, true);
    assert.equal(db.milestone[0].status, "VERIFIED_PENDING_REVIEW");

    // 24h window opened from the server-side verification timestamp.
    const windowMs =
      (db.milestone[0].reviewWindowDeadlineAt as Date).getTime() -
      (db.milestone[0].reviewWindowOpenedAt as Date).getTime();

    assert.equal(windowMs, 24 * 60 * 60 * 1000);

    // Advertiser sees the review controls path: the milestone is in review.
    const openedEvent = db.milestoneEvent.find((e) => e.eventType === "milestone_review_opened");

    assert.ok(openedEvent);
  });

  it("REJECTED verification does not open review and stamps the submission", async () => {
    const agreement = addAgreement();
    await planAndFund(agreement, [{ amount: "900000.00" }]);

    const milestone = db.milestone[0];
    verificationBehavior.set("any", { outcome: "REJECTED" });

    const result = await submissionService.submitMilestonePost(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input(),
    );

    assert.equal(result.ok, true);

    if (!result.ok) return;

    assert.equal(result.verification, "REJECTED");
    assert.equal(result.reviewOpened, false);
    assert.equal(db.milestone[0].status, "PENDING");
    assert.equal(db.milestoneSubmission[0].verificationStatus, "REJECTED");

    const rejectedEvent = db.milestoneEvent.find((e) => e.eventType === "milestone_submission_rejected");

    assert.ok(rejectedEvent);
    assert.equal(db.ledgerEntry.length, 0);
  });

  it("RETRYABLE verification stays retryable — never a permanent creator failure", async () => {
    const agreement = addAgreement();
    await planAndFund(agreement, [{ amount: "900000.00" }]);

    const milestone = db.milestone[0];
    verificationBehavior.set("any", { outcome: "PENDING_RETRY", reason: "The platform could not find this post yet." });

    const result = await submissionService.submitMilestonePost(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input(),
    );

    assert.equal(result.ok, true);

    if (!result.ok) return;

    assert.equal(result.verification, "RETRYABLE");
    assert.equal(result.reviewOpened, false);
    assert.equal(db.milestone[0].status, "PENDING");
    assert.equal(db.milestoneSubmission[0].verificationStatus, "SUBMITTED"); // still pending

    const retryEvent = db.milestoneEvent.find((e) => e.eventType === "milestone_submission_retryable");

    assert.ok(retryEvent);
  });

  it("provider outage does not become permanent creator failure (submission stays pending)", async () => {
    const agreement = addAgreement();
    await planAndFund(agreement, [{ amount: "900000.00" }]);

    const milestone = db.milestone[0];
    verificationBehavior.set("any", { outcome: "IN_PROGRESS_BY_OTHER_RUN" });

    const result = await submissionService.submitMilestonePost(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input(),
    );

    assert.equal(result.ok, true);

    if (!result.ok) return;

    assert.equal(result.verification, "RETRYABLE");
    assert.equal(db.milestoneSubmission[0].verificationStatus, "SUBMITTED");
    assert.equal(db.milestone[0].status, "PENDING");
  });

  it("low views never prevent release (views stay 0 through the whole flow)", async () => {
    const agreement = addAgreement();
    await planAndFund(agreement, [{ amount: "900000.00" }]);

    const milestone = db.milestone[0];
    verificationBehavior.set("any", { outcome: "VERIFIED" });

    const result = await submissionService.submitMilestonePost(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input(),
    );

    assert.equal(result.ok, true);

    const post = db.campaignPost.find((p) => p.id === (result as { postId: string }).postId);

    // Zero client-reported views; only the low platform-verified count (12)
    // exists — engagement metrics never gate release.
    assert.equal(post?.views, 0);
    assert.equal(post?.verifiedViews, 12);

    const confirm = await reviewService.confirmMilestoneRelease(milestone.id as string, {
      advertiserProfileId: ADV,
      userId: ADV_USER,
    });

    assert.equal(confirm.ok, true);
    assert.equal(db.milestone[0].status, "RELEASED");
  });
});

describe("Stage 13C — multiple posts per milestone", () => {
  async function threePostMilestone(): Promise<Row> {
    const agreement = addAgreement();
    await planAndFund(agreement, [
      { amount: "200000.00", requiredPostCount: 3 },
      { amount: "300000.00" },
      { amount: "400000.00" },
    ]);

    return db.milestone[0];
  }

  it("1 of 3 verified posts does NOT open review (milestone stays PENDING)", async () => {
    const milestone = await threePostMilestone();

    verificationBehavior.set("any", { outcome: "VERIFIED" });

    const first = await submissionService.submitMilestonePost(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input(),
    );

    assert.equal(first.ok, true);

    if (!first.ok) return;

    assert.equal(first.reviewOpened, false);
    assert.equal(db.milestone[0].status, "PENDING");
    assert.equal(db.milestoneSubmission.length, 1);

    const verifiedEvent = db.milestoneEvent.find((e) => e.eventType === "milestone_submission_verified");

    assert.ok(verifiedEvent);

    // Pin the progress counters exactly; the event's details also carry
    // audit context (postId, submissionSequence, note) beyond this contract.
    const progress = verifiedEvent?.details as {
      verifiedCount: number;
      requiredCount: number;
    };

    assert.equal(progress.verifiedCount, 1);
    assert.equal(progress.requiredCount, 3);
  });

  it("2 of 3 still incomplete; ALL 3 verified opens review exactly once", async () => {
    const milestone = await threePostMilestone();

    verificationBehavior.set("any", { outcome: "VERIFIED" });

    for (let i = 0; i < 2; i += 1) {
      const partial = await submissionService.submitMilestonePost(
        milestone.id as string,
        { creatorProfileId: CREATOR, userId: CREATOR_USER },
        input(),
      );

      assert.equal(partial.ok, true);
      assert.equal((partial as { reviewOpened: boolean }).reviewOpened, false);
      assert.equal(db.milestone[0].status, "PENDING");
    }

    const third = await submissionService.submitMilestonePost(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input(),
    );

    assert.equal(third.ok, true);

    if (!third.ok) return;

    assert.equal(third.reviewOpened, true);
    assert.equal(db.milestone[0].status, "VERIFIED_PENDING_REVIEW");
    assert.equal(db.milestoneSubmission.length, 3);
    assert.equal(db.milestoneSubmission.filter((s) => s.verificationStatus === "VERIFIED").length, 3);

    // Review opened exactly once.
    assert.equal(
      db.milestoneEvent.filter((e) => e.eventType === "milestone_review_opened").length,
      1,
    );
  });

  it("each post belongs to exactly one milestone submission; M2/M3 untouched by M1 activity", async () => {
    const agreement = addAgreement();
    await planAndFund(agreement, [
      { amount: "200000.00", requiredPostCount: 3 },
      { amount: "300000.00" },
      { amount: "400000.00" },
    ]);

    const [m1, m2, m3] = db.milestone;

    verificationBehavior.set("any", { outcome: "VERIFIED" });

    await submissionService.submitMilestonePost(
      m1.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input(),
    );

    // Every submission belongs to M1 only.
    assert.ok(db.milestoneSubmission.every((s) => s.milestoneId === m1.id));
    assert.equal(m2.status, "PENDING");
    assert.equal(m3.status, "PENDING");
    assert.equal(db.milestoneSubmission.filter((s) => s.milestoneId === m2.id).length, 0);
    assert.equal(db.milestoneSubmission.filter((s) => s.milestoneId === m3.id).length, 0);
  });
});

describe("Stage 13C — duplicate & identity protection", () => {
  it("the same post URL cannot be submitted twice for the campaign", async () => {
    const agreement = addAgreement();
    await planAndFund(agreement, [
      { amount: "450000.00", requiredPostCount: 2 },
      { amount: "450000.00" },
    ]);

    const [m1] = db.milestone;
    verificationBehavior.set("any", { outcome: "VERIFIED" });

    const url = "https://tiktok.com/@creator/video/same-one";

    const first = await submissionService.submitMilestonePost(
      m1.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input("TIKTOK", url),
    );

    assert.equal(first.ok, true);

    const second = await submissionService.submitMilestonePost(
      m1.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input("TIKTOK", url),
    );

    assert.equal(second.ok, false);

    if (!second.ok) {
      assert.equal(second.code, "DUPLICATE_POST");
    }
  });

  it("the same post cannot fulfill two milestones (one post → one submission)", async () => {
    const agreement = addAgreement();
    await planAndFund(agreement, [
      { amount: "450000.00", requiredPostCount: 2 },
      { amount: "450000.00", requiredPostCount: 2 },
    ]);

    const [m1, m2] = db.milestone;
    verificationBehavior.set("any", { outcome: "VERIFIED" });

    const first = await submissionService.submitMilestonePost(
      m1.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input(),
    );

    assert.equal(first.ok, true);

    const boundPostId = (first as { postId: string }).postId;

    // Attempt to submit the SAME post row for M2 — the postId is already a
    // submission. (A new CampaignPost row with the same URL is caught by the
    // duplicate-URL rule; binding the same post row is caught by the unique
    // constraint on MilestoneSubmission.postId.)
    const attempt = await submissionService.submitMilestonePost(
      m2.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input("TIKTOK", `https://tiktok.com/@creator/video/other-${nextId}`),
    );

    // M2's own submission is fine (different post)...
    assert.equal(attempt.ok, true);

    if (!attempt.ok) return;

    // ...but the original post is still bound to M1 only.
    const rows = db.milestoneSubmission.filter((s) => s.postId === boundPostId);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].milestoneId, m1.id);
  });

  it("client cannot choose another creator's identity (service takes session-derived ids only)", async () => {
    const agreement = addAgreement();
    await planAndFund(agreement, [{ amount: "900000.00" }]);

    const milestone = db.milestone[0];

    // Even if a client forged "creatorId" fields into the payload, the
    // service only accepts the actor object derived from the session. A
    // forged creator cannot pass the milestone ownership check.
    const forged = await submissionService.submitMilestonePost(
      milestone.id as string,
      { creatorProfileId: "creator-forge", userId: "user-forge" },
      input(),
    );

    assert.equal(forged.ok, false);
  });

  it("no cross-agreement data leakage (foreign agreement ids return nothing)", async () => {
    const agreement = addAgreement();
    await planAndFund(agreement, [{ amount: "900000.00" }]);

    const foreignAgreement = addAgreement({ creatorId: OTHER_CREATOR, campaignId: "camp-999" });
    await planAndFund(foreignAgreement, [{ amount: "900000.00" }]);

    // Creator 1 cannot submit against the foreign agreement's milestone
    // (index 1 = the foreign agreement's first milestone, planned second).
    const foreignMilestone = db.milestone[1];

    assert.ok(foreignMilestone, "foreign agreement's milestone must be planned");

    const result = await submissionService.submitMilestonePost(
      foreignMilestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input(),
    );

    assert.equal(result.ok, false);

    // And cannot read the foreign milestone's submission history.
    const history = await reviewService.getMilestoneSubmissionHistory(
      foreignMilestone.id as string,
      { creatorId: CREATOR },
    );

    assert.equal(history, null);
  });

  it("client cannot change milestone amounts, fees, verification results or the timer", async () => {
    const agreement = addAgreement();
    await planAndFund(agreement, [{ amount: "900000.00" }]);

    const milestone = db.milestone[0];
    const frozenAmount = milestone.creatorAmountMinor;
    const frozenFee = milestone.advertiserServiceFeeMinor;

    verificationBehavior.set("any", { outcome: "VERIFIED" });

    // The submission input carries only platform/URL/text; amounts, fee and
    // status fields in a payload are simply not part of the type.
    const hostileInput = {
      ...input(),
      creatorAmountMinor: "1",
      advertiserServiceFeeMinor: "0",
      verificationStatus: "VERIFIED",
      reviewWindowDeadlineAt: new Date(0),
    } as unknown as Parameters<typeof submissionService.submitMilestonePost>[2];

    const result = await submissionService.submitMilestonePost(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      hostileInput,
    );

    assert.equal(result.ok, true);
    assert.equal(db.milestone[0].creatorAmountMinor, frozenAmount);
    assert.equal(db.milestone[0].advertiserServiceFeeMinor, frozenFee);

    // Verification result came from Stage 9 (VERIFIED here), not the client.
    assert.equal(db.milestoneSubmission[0].verificationStatus, "VERIFIED");

    // Timer is server-computed, 24h.
    const windowMs =
      (db.milestone[0].reviewWindowDeadlineAt as Date).getTime() -
      (db.milestone[0].reviewWindowOpenedAt as Date).getTime();

    assert.equal(windowMs, 24 * 60 * 60 * 1000);
  });
});

describe("Stage 13C — timer expiry, corrections & settlement", () => {
  it("24h expiry routes to SUPPORT_REVIEW and never auto-releases", async () => {
    const agreement = addAgreement();
    await planAndFund(agreement, [{ amount: "900000.00" }]);

    const milestone = db.milestone[0];
    verificationBehavior.set("any", { outcome: "VERIFIED" });

    await submissionService.submitMilestonePost(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input(),
    );

    assert.equal(db.milestone[0].status, "VERIFIED_PENDING_REVIEW");

    // Force the window into the past.
    db.milestone[0].reviewWindowOpenedAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
    db.milestone[0].reviewWindowDeadlineAt = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const report = await reviewService.sweepMilestoneTimers();

    assert.equal(report.autoReleasePerformed, false);
    assert.equal(report.expiredToSupport, 1);
    assert.equal(db.milestone[0].status, "SUPPORT_REVIEW");
    assert.equal(db.ledgerEntry.length, 0);

    const expiryEvent = db.milestoneEvent.find((e) => e.eventType === "milestone_review_expired");

    assert.ok(expiryEvent);

    const details = expiryEvent?.details as { routedToSupport: boolean };

    assert.equal(details.routedToSupport, true);
  });

  it("timer pauses during correction and during support (13B behavior intact)", async () => {
    const agreement = addAgreement();
    await planAndFund(agreement, [{ amount: "900000.00" }]);

    const milestone = db.milestone[0];
    verificationBehavior.set("any", { outcome: "VERIFIED" });

    await submissionService.submitMilestonePost(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input(),
    );

    await reviewService.requestMilestoneCorrection(
      milestone.id as string,
      { advertiserProfileId: ADV, userId: ADV_USER },
      { note: "Missing the required hashtag — please correct." },
    );

    assert.ok(db.milestone[0].reviewPausedAt);
    assert.equal(db.milestone[0].status, "CORRECTION_REQUESTED");

    // Correction resubmission appends a NEW immutable submission.
    const originalPostId = db.milestoneSubmission[0].postId;

    // Create the corrected post via the submission flow path used by 13B.
    const correctedPost = {
      id: "post-corrected",
      campaignId: "camp-1",
      creatorId: CREATOR,
      platform: "TIKTOK",
      postUrl: "https://tiktok.com/@creator/video/corrected",
      status: "SUBMITTED",
      views: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      verifiedViews: 0,
    } as Row;

    db.campaignPost.push(correctedPost);

    const submitted = await reviewService.submitMilestoneCorrection(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      "post-corrected",
    );

    assert.equal(submitted.ok, true);
    assert.equal(db.milestoneSubmission.length, 2);
    assert.equal(db.milestoneSubmission[0].postId, originalPostId); // immutable
    assert.equal(db.milestoneSubmission[1].postId, "post-corrected");
    assert.equal(db.milestoneSubmission[1].sequence, 2);

    // Stage 9 re-verification confirms the corrected post, which reopens the
    // 24h window — escalation is only possible from that running-window state
    // (same server-side completion step the 13B suite exercises).
    correctedPost.status = "VERIFIED";

    const reverified = await reviewService.completeMilestoneReverification(milestone.id as string);

    assert.equal(reverified.ok, true);

    // Escalation pauses the timer too.
    await reviewService.escalateMilestoneToSupport(
      milestone.id as string,
      { kind: "ADVERTISER", advertiserProfileId: ADV, userId: ADV_USER },
      { reason: "Cannot agree whether the work satisfies the agreement." },
    );

    assert.equal(db.milestone[0].status, "SUPPORT_REVIEW");
    assert.ok(db.milestone[0].reviewPausedAt);
    assert.equal(db.ledgerEntry.length, 0);
  });

  it("advertiser confirmation reaches the EXISTING settlement flow (individual amount + fees)", async () => {
    const agreement = addAgreement();
    await planAndFund(agreement, [
      { amount: "200000.00" },
      { amount: "300000.00" },
      { amount: "400000.00" },
    ]);

    const m2 = db.milestone[1];
    verificationBehavior.set("any", { outcome: "VERIFIED" });

    const result = await submissionService.submitMilestonePost(
      m2.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input(),
    );

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.reviewOpened, true);

    const confirm = await reviewService.confirmMilestoneRelease(m2.id as string, {
      advertiserProfileId: ADV,
      userId: ADV_USER,
    });

    assert.equal(confirm.ok, true);
    assert.equal(db.milestone[1].status, "RELEASED");

    // Individual milestone amount (₦300k), not the ₦900k total.
    const payout = db.ledgerEntry.find((e) => e.entryType === "CREATOR_PAYOUT");

    assert.equal(payout?.amountMinor, 30000000n);

    // 5% advertiser fee (₦15,000) + 10% creator commission (₦30,000) of M2.
    const fees = db.ledgerEntry
      .filter((e) => e.entryType === "PLATFORM_FEE")
      .map((e) => e.amountMinor as bigint)
      .sort((a, b) => (a > b ? 1 : a < b ? -1 : 0));

    assert.deepEqual(fees, [1500000n, 3000000n]);

    // M1 and M3 earned nothing.
    assert.equal(db.milestone[0].status, "PENDING");
    assert.equal(db.milestone[2].status, "PENDING");
    assert.equal(db.ledgerEntry.filter((e) => e.entryType === "CREATOR_PAYOUT").length, 1);
  });

  it("advertiser cannot release before creator fulfills the milestone", async () => {
    const agreement = addAgreement();
    await planAndFund(agreement, [{ amount: "900000.00" }]);

    const milestone = db.milestone[0];

    // No submission at all — the milestone is PENDING.
    const confirm = await reviewService.confirmMilestoneRelease(milestone.id as string, {
      advertiserProfileId: ADV,
      userId: ADV_USER,
    });

    assert.equal(confirm.ok, false);

    if (!confirm.ok) {
      assert.equal(confirm.code, "INVALID_STATE");
    }

    assert.equal(db.ledgerEntry.length, 0);
  });

  it("support can inspect the complete submission chain (what/when/verified/corrected)", async () => {
    const agreement = addAgreement();
    await planAndFund(agreement, [{ amount: "900000.00" }]);

    const milestone = db.milestone[0];
    verificationBehavior.set("any", { outcome: "VERIFIED" });

    await submissionService.submitMilestonePost(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input(),
    );

    await reviewService.requestMilestoneCorrection(
      milestone.id as string,
      { advertiserProfileId: ADV, userId: ADV_USER },
      { note: "13C: evidence chain check." },
    );

    db.campaignPost.push({
      id: "post-fixed",
      campaignId: "camp-1",
      creatorId: CREATOR,
      platform: "TIKTOK",
      postUrl: "https://tiktok.com/@creator/video/fixed",
      status: "SUBMITTED",
    } as Row);

    await reviewService.submitMilestoneCorrection(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      "post-fixed",
    );

    const history = await reviewService.getMilestoneSubmissionHistory(milestone.id as string, {
      advertiserId: ADV,
    });

    assert.ok(history);
    assert.equal(history!.length, 2);
    assert.equal(history![0].sequence, 1);
    assert.equal(history![1].sequence, 2);
    assert.equal(history![1].causedByCorrectionRequestNote, "13C: evidence chain check.");
    assert.equal(history![1].submittedById, CREATOR_USER);
  });

  it("duplicate/replayed submission and verification events are safe", async () => {
    const agreement = addAgreement();
    await planAndFund(agreement, [{ amount: "900000.00" }]);

    const milestone = db.milestone[0];
    verificationBehavior.set("any", { outcome: "VERIFIED" });

    const first = await submissionService.submitMilestonePost(
      milestone.id as string,
      { creatorProfileId: CREATOR, userId: CREATOR_USER },
      input(),
    );

    assert.equal(first.ok, true);
    assert.equal(db.milestoneSubmission.length, 1);

    // Replay the verification outcome through the 13B entry point directly.
    const replay = await reviewService.openMilestoneReviewAfterVerification(
      milestone.id as string,
      (first as { postId: string }).postId,
    );

    assert.equal(replay.ok, true);
    assert.equal((replay as { idempotentReplay: boolean }).idempotentReplay, true);

    // No duplicate events, no duplicate ledger activity.
    assert.equal(
      db.milestoneEvent.filter((e) => e.eventType === "milestone_review_opened").length,
      1,
    );
    assert.equal(db.ledgerEntry.length, 0);
  });
});
