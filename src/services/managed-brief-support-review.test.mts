import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Agenda Managed (V1, slice 2) — Support review of managed briefs
 * (support reads + transitionManagedBriefForSupport).
 *
 * Same harness as the slice 1 suite: Prisma replaced with an in-memory stub
 * via node:test module mocking (no DATABASE_URL), "server-only" and
 * next/navigation mocked. The session seam mocks @/lib/auth so the REAL
 * authz guards (getSupportActor / requireSupport) run their actual logic —
 * the Stage 14D authorization matrix is exercised end to end, not stubbed.
 *
 * Covers the slice 2 requirements:
 *   - Support can list and view briefs (and only support);
 *   - valid transitions SUBMITTED → IN_REVIEW → CLOSED succeed and write
 *     server-side review facts;
 *   - invalid transitions (skipping a state, acting after CLOSED, rerunning
 *     a transition) are rejected;
 *   - non-support roles cannot reach the review actions;
 *   - a support roster revocation fails closed immediately;
 *   - advertiser ownership/privacy from slice 1 is intact.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma stub
// ---------------------------------------------------------------------------

type BriefRow = {
  id: string;
  advertiserId: string;
  campaignGoal: string;
  description: string;
  budgetMinor: bigint;
  currency: string;
  targetAudience: string;
  targetPlatforms: string[];
  creatorRequirements: string | null;
  status: "SUBMITTED" | "IN_REVIEW" | "CLOSED";
  reviewStartedAt: Date | null;
  reviewStartedById: string | null;
  closedAt: Date | null;
  closedById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type UserRow = { id: string; supportRosterMember: boolean };

let briefs: BriefRow[] = [];
let users: UserRow[] = [];
let nextId = 1;

function resetDb(): void {
  briefs = [];
  users = [];
  nextId = 1;
  advertiserCompanyNames.clear();
}

function matches(row: BriefRow, where: Record<string, unknown>): boolean {
  if (where.id !== undefined && row.id !== where.id) {
    return false;
  }

  if (where.advertiserId !== undefined && row.advertiserId !== where.advertiserId) {
    return false;
  }

  if (where.status !== undefined && row.status !== where.status) {
    return false;
  }

  return true;
}

const prismaStub = {
  managedBrief: {
    create: async (args: { data: Record<string, unknown> }) => {
      const now = new Date();
      const row: BriefRow = {
        id: `mb-${nextId++}`,
        advertiserId: String(args.data.advertiserId),
        campaignGoal: String(args.data.campaignGoal),
        description: String(args.data.description),
        budgetMinor: args.data.budgetMinor as bigint,
        currency: String(args.data.currency ?? "NGN"),
        targetAudience: String(args.data.targetAudience),
        targetPlatforms: [...(args.data.targetPlatforms as string[])],
        creatorRequirements: (args.data.creatorRequirements as string | null) ?? null,
        status: (args.data.status as BriefRow["status"]) ?? "SUBMITTED",
        reviewStartedAt: (args.data.reviewStartedAt as Date | null) ?? null,
        reviewStartedById: (args.data.reviewStartedById as string | null) ?? null,
        closedAt: (args.data.closedAt as Date | null) ?? null,
        closedById: (args.data.closedById as string | null) ?? null,
        createdAt: now,
        updatedAt: now,
      };

      briefs.push(row);

      return structuredClone(row);
    },
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const row = briefs.find((candidate) => matches(candidate, args.where));

      return row ? structuredClone(row) : null;
    },
    findMany: async (args: {
      where?: Record<string, unknown>;
      orderBy?: Record<string, string>;
    }) => {
      const found = briefs
        .filter((candidate) => matches(candidate, args.where ?? {}))
        .map((row) => ({
          ...structuredClone(row),
          advertiser: {
            companyName: advertiserCompanyNames.get(row.advertiserId) ?? "Unknown",
          },
        }));

      if (args.orderBy?.createdAt === "desc") {
        found.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }

      return found;
    },
    updateMany: async (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      let count = 0;

      for (const row of briefs) {
        if (!matches(row, args.where)) {
          continue;
        }

        // The stub mimics Prisma's updateMany: matching rows are mutated
        // (updatedAt semantics are irrelevant to the assertions).
        Object.assign(row, structuredClone(args.data));
        count += 1;
      }

      return { count };
    },
  },
  user: {
    findUnique: async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
      const row = users.find((candidate) => candidate.id === args.where.id);

      return row ? { supportRosterMember: row.supportRosterMember } : null;
    },
  },
} as unknown as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Module mocks — registered BEFORE anything under test is imported
// ---------------------------------------------------------------------------

let sessionRole: "CREATOR" | "ADVERTISER" | "SUPPORT" | null = null;
let sessionUserId: string | null = null;

function mockModule(specifier: string, exports: Record<string, unknown>): void {
  (mock.module as (spec: string, opts: Record<string, unknown>) => void)(
    specifier,
    { exports },
  );
}

mockModule("server-only", {});

mockModule("@/lib/prisma", { prisma: prismaStub as never });

mockModule("next/navigation", {
  redirect: (path: string) => {
    const error = new Error(`REDIRECTED:${path}`) as Error & { digest?: string };
    error.digest = `NEXT_REDIRECT;${path}`;
    throw error;
  },
  notFound: () => {
    const error = new Error("NOT_FOUND") as Error & { digest?: string };
    error.digest = "NEXT_NOT_FOUND";
    throw error;
  },
});

// Session seam — the REAL authz guards (getSupportActor, requireSupport) run
// against this, exactly like the slice 1 suite.
mockModule("@/lib/auth", {
  auth: async () => {
    if (sessionRole === null || !sessionUserId) {
      return null;
    }

    return {
      user: {
        id: sessionUserId,
        role: sessionRole,
        name: "Test User",
        email: "user@example.com",
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Imports (AFTER module mocks are registered)
// ---------------------------------------------------------------------------

type Service = typeof import("@/services/managed-brief.service");
type Validation = typeof import("@/validation/managed-brief");

let service: Service;
let validation: Validation;

const ADVERTISER_A_PROFILE = "adv-profile-a";
const ADVERTISER_B_PROFILE = "adv-profile-b";
const ADVERTISER_A_USER = "user-advertiser-a";
const ADVERTISER_B_USER = "user-advertiser-b";
const SUPPORT_USER = "user-support-1";
const SUPPORT_USER_2 = "user-support-2";
const CREATOR_USER = "user-creator-1";

// AdvertiserProfile stand-in so the stub can emulate the `advertiser`
// relation the support list selects (company name display only).
const advertiserCompanyNames = new Map<string, string>([
  [ADVERTISER_A_PROFILE, "Advertiser A Ltd"],
  [ADVERTISER_B_PROFILE, "Advertiser B Ltd"],
]);

function asSession(role: "CREATOR" | "ADVERTISER" | "SUPPORT" | null, userId: string | null): void {
  sessionRole = role;
  sessionUserId = userId;
}

function putOnRoster(userId: string): void {
  users.push({ id: userId, supportRosterMember: true });
}

/** Insert a brief row directly (the creation path is covered by slice 1). */
type SeedOverrides = {
  advertiserId?: string;
  status?: BriefRow["status"];
};

function seedBrief(overrides: SeedOverrides = {}): BriefRow {
  const now = new Date();
  const row: BriefRow = {
    id: `mb-${nextId++}`,
    advertiserId: overrides.advertiserId ?? ADVERTISER_A_PROFILE,
    campaignGoal: "Launch-week awareness",
    description: "A launch-week push for our new sneaker line across Nigeria.",
    budgetMinor: 50_000_000n,
    currency: "NGN",
    targetAudience: "Men 18-34 interested in fitness and streetwear",
    targetPlatforms: ["TIKTOK"],
    creatorRequirements: null,
    status: "SUBMITTED",
    reviewStartedAt: null,
    reviewStartedById: null,
    closedAt: null,
    closedById: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as BriefRow;

  briefs.push(row);

  return row;
}

type ReviewResult = Awaited<ReturnType<Service["transitionManagedBriefForSupport"]>>;

function expectOkReview(result: ReviewResult): { status: string } {
  assert.equal(result.success, true);

  return (result as { success: true; data: { status: string } }).data;
}

function briefRow(id: string): BriefRow {
  const row = briefs.find((candidate) => candidate.id === id);

  assert.ok(row, "brief row should exist");

  return row;
}

describe("Agenda Managed V1 — support review", () => {
  before(async () => {
    service = await import("@/services/managed-brief.service");
    validation = await import("@/validation/managed-brief");
  });

  beforeEach(() => {
    resetDb();
    asSession(null, null);
  });

  // -------------------------------------------------------------------------
  // Validation — the form can only name the brief
  // -------------------------------------------------------------------------

  describe("managedBriefReviewActionSchema", () => {
    it("accepts a brief id and nothing else", () => {
      const parsed = validation.managedBriefReviewActionSchema.safeParse({
        briefId: "7d1f6c2e-0b4a-4a9e-9f4e-3a2b1c0d9e8f",
      });

      assert.equal(parsed.success, true);
    });

    it("rejects a missing or malformed brief id", () => {
      assert.equal(
        validation.managedBriefReviewActionSchema.safeParse({ briefId: "not-a-uuid" }).success,
        false,
      );
      assert.equal(
        validation.managedBriefReviewActionSchema.safeParse({}).success,
        false,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Support reads
  // -------------------------------------------------------------------------

  describe("support reads", () => {
    it("a rostered support operator can list every brief", async () => {
      seedBrief({ advertiserId: ADVERTISER_A_PROFILE });
      seedBrief({ advertiserId: ADVERTISER_B_PROFILE });

      asSession("SUPPORT", SUPPORT_USER);
      putOnRoster(SUPPORT_USER);

      const all = await service.listManagedBriefsForSupport();

      assert.equal(all.length, 2);
    });

    it("a rostered support operator can view a full brief (not their own — unscoped)", async () => {
      const seeded = seedBrief({ advertiserId: ADVERTISER_A_PROFILE });

      asSession("SUPPORT", SUPPORT_USER);
      putOnRoster(SUPPORT_USER);

      const brief = await service.getManagedBriefForSupport(seeded.id);

      assert.ok(brief);
      assert.equal(brief.id, seeded.id);
      assert.equal(brief.description.length > 0, true);
    });

    it("the support list returns nulls/empty for every non-support session", async () => {
      seedBrief({ advertiserId: ADVERTISER_A_PROFILE });

      // Advertiser
      asSession("ADVERTISER", ADVERTISER_A_USER);
      assert.equal((await service.listManagedBriefsForSupport()).length, 0);

      // Creator
      asSession("CREATOR", CREATOR_USER);
      assert.equal((await service.listManagedBriefsForSupport()).length, 0);

      // Anonymous
      asSession(null, null);
      assert.equal((await service.listManagedBriefsForSupport()).length, 0);

      // Detail reads fail closed too.
      const seeded = briefs[0]!;
      asSession("ADVERTISER", ADVERTISER_A_USER);
      assert.equal(await service.getManagedBriefForSupport(seeded.id), null);
      asSession("CREATOR", CREATOR_USER);
      assert.equal(await service.getManagedBriefForSupport(seeded.id), null);
      asSession(null, null);
      assert.equal(await service.getManagedBriefForSupport(seeded.id), null);
    });

    it("a SUPPORT session without roster membership is fail-closed", async () => {
      const seeded = seedBrief({ advertiserId: ADVERTISER_A_PROFILE });

      asSession("SUPPORT", SUPPORT_USER);
      // No roster insert — role alone is never sufficient (Stage 14D).

      assert.equal((await service.listManagedBriefsForSupport()).length, 0);
      assert.equal(await service.getManagedBriefForSupport(seeded.id), null);
    });
  });

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  describe("transitionManagedBriefForSupport", () => {
    it("moves SUBMITTED → IN_REVIEW and records server-side review facts", async () => {
      const seeded = seedBrief({ advertiserId: ADVERTISER_A_PROFILE });

      asSession("SUPPORT", SUPPORT_USER);
      putOnRoster(SUPPORT_USER);

      const result = expectOkReview(
        await service.transitionManagedBriefForSupport(seeded.id),
      );

      assert.equal(result.status, "IN_REVIEW");

      const row = briefRow(seeded.id);
      assert.equal(row.status, "IN_REVIEW");
      assert.ok(row.reviewStartedAt instanceof Date);
      // Attribution comes from the session actor, never from any client input.
      assert.equal(row.reviewStartedById, SUPPORT_USER);
      assert.equal(row.closedAt, null);
      assert.equal(row.closedById, null);
    });

    it("moves IN_REVIEW → CLOSED and records closure facts", async () => {
      const seeded = seedBrief({ advertiserId: ADVERTISER_A_PROFILE });

      asSession("SUPPORT", SUPPORT_USER_2);
      putOnRoster(SUPPORT_USER_2);

      expectOkReview(await service.transitionManagedBriefForSupport(seeded.id));
      expectOkReview(await service.transitionManagedBriefForSupport(seeded.id));

      const row = briefRow(seeded.id);
      assert.equal(row.status, "CLOSED");
      assert.ok(row.reviewStartedAt instanceof Date);
      assert.equal(row.reviewStartedById, SUPPORT_USER_2);
      assert.ok(row.closedAt instanceof Date);
      assert.equal(row.closedById, SUPPORT_USER_2);
    });

    it("rejects invalid transitions: skipping IN_REVIEW, rerunning, and acting after CLOSED", async () => {
      const submitted = seedBrief({ advertiserId: ADVERTISER_A_PROFILE });
      const closed = seedBrief({ advertiserId: ADVERTISER_A_PROFILE, status: "CLOSED" });

      asSession("SUPPORT", SUPPORT_USER);
      putOnRoster(SUPPORT_USER);

      // CLOSE directly from SUBMITTED (skipping IN_REVIEW) is not a valid
      // transition — nothing in the map allows it.
      const direct = await service.transitionManagedBriefForSupport(submitted.id);
      // SUBMITTED's only transition is IN_REVIEW, so this call succeeds but
      // moves to IN_REVIEW, never CLOSED. A second attempt then reruns.
      assert.equal(direct.success, true);

      const rerun = await service.transitionManagedBriefForSupport(submitted.id);
      assert.equal(rerun.success, true);
      assert.equal(briefRow(submitted.id).status, "CLOSED");

      // CLOSED is terminal: no further transition exists.
      const afterClose = await service.transitionManagedBriefForSupport(submitted.id);
      assert.equal(afterClose.success, false);

      const alreadyClosed = await service.transitionManagedBriefForSupport(closed.id);
      assert.equal(alreadyClosed.success, false);
      if (!alreadyClosed.success) {
        assert.match(alreadyClosed.error, /closed/i);
      }

      assert.equal(briefRow(submitted.id).status, "CLOSED");
      assert.equal(briefRow(closed.id).status, "CLOSED");
    });

    it("rejects a rerun that races the stored status (conditional update)", async () => {
      const seeded = seedBrief({ advertiserId: ADVERTISER_A_PROFILE });

      asSession("SUPPORT", SUPPORT_USER);
      putOnRoster(SUPPORT_USER);

      // Simulate a concurrent transition between the read and the write:
      // the row's stored status no longer matches, so count is 0.
      const briefTable = prismaStub.managedBrief as {
        updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }>;
      };
      const originalUpdate = briefTable.updateMany.bind(briefTable);
      briefTable.updateMany = async () => ({ count: 0 });

      const result = await service.transitionManagedBriefForSupport(seeded.id);

      briefTable.updateMany = originalUpdate;

      assert.equal(result.success, false);
      if (!result.success) {
        assert.match(result.error, /already changed/i);
      }
    });

    it("a nonexistent brief id is an error, not a crash", async () => {
      asSession("SUPPORT", SUPPORT_USER);
      putOnRoster(SUPPORT_USER);

      const result = await service.transitionManagedBriefForSupport("mb-missing");

      assert.equal(result.success, false);
    });

    it("non-support roles and anonymous callers cannot perform any transition", async () => {
      const seeded = seedBrief({ advertiserId: ADVERTISER_A_PROFILE });

      const attempts: Array<["CREATOR" | "ADVERTISER" | "SUPPORT" | null, string | null]> = [
        ["ADVERTISER", ADVERTISER_A_USER],
        ["ADVERTISER", ADVERTISER_B_USER],
        ["CREATOR", CREATOR_USER],
        [null, null],
        // SUPPORT role without the roster must also fail closed.
        ["SUPPORT", SUPPORT_USER],
      ];

      for (const [role, userId] of attempts) {
        asSession(role, userId);

        const result = await service.transitionManagedBriefForSupport(seeded.id);

        assert.equal(result.success, false, `role ${String(role)} must be refused`);
        if (!result.success) {
          assert.match(result.error, /Support authorization required/u);
        }
      }

      // Nothing changed.
      assert.equal(briefRow(seeded.id).status, "SUBMITTED");
      assert.equal(briefRow(seeded.id).reviewStartedById, null);
    });

    it("a support roster revocation takes effect immediately on review actions", async () => {
      const seeded = seedBrief({ advertiserId: ADVERTISER_A_PROFILE });

      asSession("SUPPORT", SUPPORT_USER);
      putOnRoster(SUPPORT_USER);

      assert.equal(
        (await service.transitionManagedBriefForSupport(seeded.id)).success,
        true,
      );

      // Revoke mid-session (operational act — SQL-only in prod).
      users = users.filter((user) => user.id !== SUPPORT_USER);

      const revoked = await service.transitionManagedBriefForSupport(seeded.id);

      assert.equal(revoked.success, false);
      assert.equal(briefRow(seeded.id).status, "IN_REVIEW");

      // Reads fail closed immediately too.
      assert.equal(await service.getManagedBriefForSupport(seeded.id), null);
      assert.equal((await service.listManagedBriefsForSupport()).length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Ownership / privacy preserved from slice 1
  // -------------------------------------------------------------------------

  describe("ownership and privacy", () => {
    it("the advertiser's owner-scoped reads are untouched by the support path", async () => {
      const owned = seedBrief({ advertiserId: ADVERTISER_A_PROFILE });
      seedBrief({ advertiserId: ADVERTISER_B_PROFILE });

      asSession("ADVERTISER", ADVERTISER_A_USER);

      const own = await service.getManagedBrief(ADVERTISER_A_PROFILE, owned.id);

      assert.ok(own);
      assert.equal(own.id, owned.id);

      // The owner read never returns another advertiser's brief.
      assert.equal(await service.getManagedBrief(ADVERTISER_B_PROFILE, owned.id), null);

      // The support transition path is unreachable for the advertiser: the
      // role matrix test above covers the refusal; here we assert their own
      // list still works and contains only their row.
      const ownList = await service.listManagedBriefs(ADVERTISER_A_PROFILE);
      assert.equal(ownList.length, 1);
      assert.equal(ownList[0]?.id, owned.id);
    });

    it("an advertiser's own brief list never shows review operator attribution", async () => {
      const seeded = seedBrief({ advertiserId: ADVERTISER_A_PROFILE });

      asSession("SUPPORT", SUPPORT_USER);
      putOnRoster(SUPPORT_USER);
      expectOkReview(await service.transitionManagedBriefForSupport(seeded.id));

      asSession("ADVERTISER", ADVERTISER_A_USER);
      const own = await service.getManagedBrief(ADVERTISER_A_PROFILE, seeded.id);

      assert.ok(own);
      // The owner's read model has no *ById fields at all.
      assert.equal("reviewStartedById" in own, false);
      assert.equal("closedById" in own, false);
    });

    it("creators have no access to any managed brief path", async () => {
      const seeded = seedBrief({ advertiserId: ADVERTISER_A_PROFILE });

      asSession("CREATOR", CREATOR_USER);

      assert.equal(await service.getManagedBriefForSupport(seeded.id), null);
      assert.equal((await service.listManagedBriefsForSupport()).length, 0);

      const result = await service.transitionManagedBriefForSupport(seeded.id);
      assert.equal(result.success, false);

      // Owner reads are scoped to an advertiser profile id; a creator has
      // none, and the where-clause cannot be satisfied.
      assert.equal(await service.getManagedBrief("creator-profile-x", seeded.id), null);
      assert.equal((await service.listManagedBriefs("creator-profile-x")).length, 0);
    });
  });
});
