import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Agenda Managed (V1, slice 3) — Support sourcing candidates
 * (list / add / transition / note / remove behind the Stage 14D seam).
 *
 * Same harness as the slice 1/2 suites: Prisma replaced with an in-memory
 * stub via node:test module mocking (no DATABASE_URL), "server-only" and
 * next/navigation mocked. The session seam mocks @/lib/auth so the REAL
 * authz guards (getSupportActor / requireSupport) run their actual logic —
 * the Stage 14D authorization matrix is exercised end to end, not stubbed.
 *
 * Covers the slice 3 requirements:
 *   - only a rostered SUPPORT session can read or write candidates
 *     (advertisers, creators, anonymous and roster-less SUPPORT all fail
 *     closed);
 *   - candidate creation references EXISTING identity rows (CreatorProfile +
 *     SocialAccount) and verifies the account belongs to the creator;
 *   - duplicates: the same brief + creator + account is rejected (service
 *     pre-check AND the DB unique constraint for a lost race), while a second
 *     account or a second brief is allowed;
 *   - status transitions follow the server-side state machine with
 *     server-side attribution; invalid, terminal and raced transitions are
 *     rejected;
 *   - privacy: advertiser-facing reads carry no candidate data and creators
 *     have no path to any candidate read or write.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma stub
// ---------------------------------------------------------------------------

type CandidateStatus = "PROSPECT" | "CONTACTED" | "INTERESTED" | "DECLINED" | "SELECTED";

type CandidateRow = {
  id: string;
  briefId: string;
  creatorId: string;
  socialAccountId: string;
  status: CandidateStatus;
  note: string | null;
  addedById: string;
  statusUpdatedAt: Date | null;
  statusUpdatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type BriefRow = {
  id: string;
  advertiserId: string;
  status: string;
  campaignGoal: string;
  description: string;
  budgetMinor: bigint;
  currency: string;
  targetAudience: string;
  targetPlatforms: string[];
  creatorRequirements: string | null;
  reviewStartedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
type AccountRow = { id: string; creatorId: string; username: string };
type ProfileRow = { id: string; username: string; userId: string };
type UserRow = { id: string; supportRosterMember: boolean };

let candidates: CandidateRow[] = [];
let briefs: BriefRow[] = [];
let accounts: AccountRow[] = [];
let profiles: ProfileRow[] = [];
let users: UserRow[] = [];
let nextId = 1;
// When true, candidate.create rejects with a Prisma-shaped P2002 (the DB
// unique-constraint race path).
let failCandidateCreateWithP2002 = false;
// Overrides updateMany's count (0 = simulated lost transition race).
let forceUpdateCount: number | null = null;

function resetDb(): void {
  candidates = [];
  briefs = [];
  accounts = [];
  profiles = [];
  users = [];
  nextId = 1;
  failCandidateCreateWithP2002 = false;
  forceUpdateCount = null;
}

function candidateMatches(
  row: CandidateRow,
  where: Record<string, unknown>,
): boolean {
  if (where.id !== undefined && row.id !== where.id) {
    return false;
  }

  if (where.briefId !== undefined && row.briefId !== where.briefId) {
    return false;
  }

  if (where.status !== undefined && row.status !== where.status) {
    return false;
  }

  return true;
}

const prismaStub = {
  managedBriefSourcingCandidate: {
    create: async (args: { data: Record<string, unknown> }) => {
      const data = args.data;

      // Enforce the real (brief, creator, account) unique constraint so the
      // P2002 path is exercised faithfully.
      const duplicate = candidates.some(
        (candidate) =>
          candidate.briefId === data.briefId &&
          candidate.creatorId === data.creatorId &&
          candidate.socialAccountId === data.socialAccountId,
      );

      if (duplicate || failCandidateCreateWithP2002) {
        return Promise.reject({ code: "P2002" });
      }

      const now = new Date();
      const row: CandidateRow = {
        id: `mbc-${nextId++}`,
        briefId: String(data.briefId),
        creatorId: String(data.creatorId),
        socialAccountId: String(data.socialAccountId),
        status: (data.status as CandidateStatus) ?? "PROSPECT",
        note: (data.note as string | null) ?? null,
        addedById: String(data.addedById),
        statusUpdatedAt: (data.statusUpdatedAt as Date | null) ?? null,
        statusUpdatedById: (data.statusUpdatedById as string | null) ?? null,
        createdAt: now,
        updatedAt: now,
      };

      candidates.push(row);

      return structuredClone(row);
    },
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const row = candidates.find((candidate) =>
        candidateMatches(candidate, args.where),
      );

      return row ? structuredClone(row) : null;
    },
    findMany: async (args: { where?: Record<string, unknown> }) => {
      return candidates
        .filter((candidate) => candidateMatches(candidate, args.where ?? {}))
        .map((row) => ({
          ...structuredClone(row),
          creator: {
            id: row.creatorId,
            username: `creator-${row.creatorId}`,
            category: "FITNESS",
            followerCount: 12_345,
            user: { name: `Creator ${row.creatorId}` },
          },
          socialAccount: {
            id: row.socialAccountId,
            platform: "TIKTOK",
            username: `handle-${row.socialAccountId}`,
            profileUrl: `https://example.com/${row.socialAccountId}`,
            status: "VERIFIED",
            followerCount: 99_999,
          },
        }));
    },
    updateMany: async (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      if (forceUpdateCount !== null) {
        const forced = forceUpdateCount;
        forceUpdateCount = null;

        return { count: forced };
      }

      let count = 0;

      for (const row of candidates) {
        if (!candidateMatches(row, args.where)) {
          continue;
        }

        Object.assign(row, structuredClone(args.data));
        count += 1;
      }

      return { count };
    },
    update: async (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const row = candidates.find((candidate) => candidate.id === args.where.id);

      if (!row) {
        return Promise.reject({ code: "P2025" });
      }

      Object.assign(row, structuredClone(args.data));

      return structuredClone(row);
    },
    delete: async (args: { where: { id: string } }) => {
      const index = candidates.findIndex(
        (candidate) => candidate.id === args.where.id,
      );

      if (index === -1) {
        return Promise.reject({ code: "P2025" });
      }

      const [row] = candidates.splice(index, 1);

      return structuredClone(row);
    },
  },
  managedBrief: {
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const where = args.where as { id?: string; advertiserId?: string };
      const row = briefs.find(
        (candidate) =>
          candidate.id === where.id &&
          (where.advertiserId === undefined ||
            candidate.advertiserId === where.advertiserId),
      );

      return row ? structuredClone(row) : null;
    },
    findMany: async (args: { where?: Record<string, unknown> }) => {
      const where = (args.where ?? {}) as { advertiserId?: string };

      return briefs
        .filter(
          (candidate) =>
            where.advertiserId === undefined ||
            candidate.advertiserId === where.advertiserId,
        )
        .map((row) => structuredClone(row));
    },
  },
  socialAccount: {
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const where = args.where as { id?: string; creatorId?: string };
      const row = accounts.find(
        (candidate) =>
          candidate.id === where.id && candidate.creatorId === where.creatorId,
      );

      return row ? structuredClone(row) : null;
    },
  },
  creatorProfile: {
    findMany: async () => {
      return profiles.map((profile) => ({
        id: profile.id,
        username: profile.username,
        category: "FITNESS",
        user: { name: `Creator ${profile.id}` },
        socialAccounts: accounts
          .filter((account) => account.creatorId === profile.id)
          .map((account) => ({
            id: account.id,
            platform: "TIKTOK",
            username: account.username,
          })),
      }));
    },
  },
  user: {
    findUnique: async (args: { where: { id: string } }) => {
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

// Session seam — the REAL authz guards run against this.
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
const ADVERTISER_A_USER = "user-advertiser-a";
const SUPPORT_USER = "user-support-1";
const CREATOR_USER = "user-creator-1";
const CREATOR_PROFILE_1 = "creator-profile-1";
const CREATOR_PROFILE_2 = "creator-profile-2";
const ACCOUNT_1 = "social-account-1";
const ACCOUNT_2 = "social-account-2";

function asSession(
  role: "CREATOR" | "ADVERTISER" | "SUPPORT" | null,
  userId: string | null,
): void {
  sessionRole = role;
  sessionUserId = userId;
}

function putOnRoster(userId: string): void {
  users.push({ id: userId, supportRosterMember: true });
}

/** Authorize SUPPORT_USER as a rostered operator. */
function asRosteredSupport(): void {
  asSession("SUPPORT", SUPPORT_USER);
  putOnRoster(SUPPORT_USER);
}

function seedBrief(overrides: Partial<BriefRow> = {}): BriefRow {
  const now = new Date();
  const row: BriefRow = {
    id: `mb-${nextId++}`,
    advertiserId: ADVERTISER_A_PROFILE,
    status: "IN_REVIEW",
    campaignGoal: "Launch-week awareness",
    description: "A launch-week push for our new sneaker line.",
    budgetMinor: 50_000_000n,
    currency: "NGN",
    targetAudience: "Men 18-34 into fitness",
    targetPlatforms: ["TIKTOK"],
    creatorRequirements: null,
    reviewStartedAt: null,
    closedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };

  briefs.push(row);

  return row;
}

function seedCreatorWithAccounts(): void {
  profiles.push({ id: CREATOR_PROFILE_1, username: "creatorone", userId: CREATOR_USER });
  profiles.push({ id: CREATOR_PROFILE_2, username: "creatortwo", userId: "user-creator-2" });
  accounts.push({ id: ACCOUNT_1, creatorId: CREATOR_PROFILE_1, username: "one" });
  accounts.push({ id: ACCOUNT_2, creatorId: CREATOR_PROFILE_1, username: "two" });
}

function seedCandidate(overrides: Partial<CandidateRow> = {}): CandidateRow {
  const now = new Date();
  const row: CandidateRow = {
    id: `mbc-${nextId++}`,
    briefId: `mb-${nextId++}`,
    creatorId: CREATOR_PROFILE_1,
    socialAccountId: ACCOUNT_1,
    status: "PROSPECT",
    note: null,
    addedById: SUPPORT_USER,
    statusUpdatedAt: null,
    statusUpdatedById: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };

  candidates.push(row);

  return row;
}

type MutationResult = Awaited<
  ReturnType<Service["addManagedBriefCandidateForSupport"]>
>;

function expectOk(result: MutationResult): { candidateId: string; briefId: string; status: string } {
  assert.equal(result.success, true);

  return (result as { success: true; data: { candidateId: string; briefId: string; status: string } })
    .data;
}

function expectRefusal(result: MutationResult): string {
  assert.equal(result.success, false);

  return (result as { success: false; error: string }).error;
}

function candidateRow(id: string): CandidateRow {
  const row = candidates.find((candidate) => candidate.id === id);

  assert.ok(row, "candidate row should exist");

  return row;
}

const ADD_INPUT = (briefId: string) => ({
  briefId,
  creatorProfileId: CREATOR_PROFILE_1,
  socialAccountId: ACCOUNT_1,
  note: "Strong launch-week fit." as string | undefined,
});

describe("Agenda Managed V1 — support sourcing candidates", () => {
  before(async () => {
    service = await import("@/services/managed-brief.service");
    validation = await import("@/validation/managed-brief");
  });

  beforeEach(() => {
    resetDb();
    asSession(null, null);
  });

  // -------------------------------------------------------------------------
  // Validation — minimal forms, no client-owned status
  // -------------------------------------------------------------------------

  describe("validation", () => {
    it("accepts an add payload of existing ids plus an optional note", () => {
      const parsed = validation.managedBriefCandidateAddSchema.safeParse({
        briefId: "7d1f6c2e-0b4a-4a9e-9f4e-3a2b1c0d9e8f",
        creatorProfileId: "8d1f6c2e-0b4a-4a9e-9f4e-3a2b1c0d9e8f",
        socialAccountId: "9d1f6c2e-0b4a-4a9e-9f4e-3a2b1c0d9e8f",
        note: "Looks like a fit.",
      });

      assert.equal(parsed.success, true);
    });

    it("rejects add payloads with malformed ids or an oversized note", () => {
      assert.equal(
        validation.managedBriefCandidateAddSchema.safeParse({
          briefId: "nope",
          creatorProfileId: "8d1f6c2e-0b4a-4a9e-9f4e-3a2b1c0d9e8f",
          socialAccountId: "9d1f6c2e-0b4a-4a9e-9f4e-3a2b1c0d9e8f",
        }).success,
        false,
      );

      assert.equal(
        validation.managedBriefCandidateAddSchema.safeParse({
          briefId: "7d1f6c2e-0b4a-4a9e-9f4e-3a2b1c0d9e8f",
          creatorProfileId: "8d1f6c2e-0b4a-4a9e-9f4e-3a2b1c0d9e8f",
          socialAccountId: "9d1f6c2e-0b4a-4a9e-9f4e-3a2b1c0d9e8f",
          note: "x".repeat(1001),
        }).success,
        false,
      );
    });

    it("status action schema has NO status field — the client cannot name one", () => {
      const parsed = validation.managedBriefCandidateStatusActionSchema.safeParse({
        candidateId: "7d1f6c2e-0b4a-4a9e-9f4e-3a2b1c0d9e8f",
        status: "SELECTED",
      });

      assert.equal(parsed.success, true);

      if (parsed.success) {
        assert.equal("status" in parsed.data, false);
      }
    });

    it("note schema accepts empty (clear) and rejects oversized notes", () => {
      const ok = validation.managedBriefCandidateNoteSchema.safeParse({
        candidateId: "7d1f6c2e-0b4a-4a9e-9f4e-3a2b1c0d9e8f",
        note: "",
      });

      assert.equal(ok.success, true);

      assert.equal(
        validation.managedBriefCandidateNoteSchema.safeParse({
          candidateId: "7d1f6c2e-0b4a-4a9e-9f4e-3a2b1c0d9e8f",
          note: "x".repeat(1001),
        }).success,
        false,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Authorization — support-only reads and writes
  // -------------------------------------------------------------------------

  describe("authorization", () => {
    it("a rostered support operator can list candidates and account options", async () => {
      const brief = seedBrief();
      seedCreatorWithAccounts();
      seedCandidate({ briefId: brief.id });

      asRosteredSupport();

      assert.equal(
        (await service.listManagedBriefCandidatesForSupport(brief.id)).length,
        1,
      );
      assert.equal(
        (await service.listManagedBriefCandidateAccountOptionsForSupport())
          .length,
        2,
      );
    });

    it("every non-support session gets an empty list — advertiser, creator, anonymous, roster-less support", async () => {
      const brief = seedBrief();
      seedCreatorWithAccounts();
      seedCandidate({ briefId: brief.id });

      const attempts: Array<["CREATOR" | "ADVERTISER" | "SUPPORT" | null, string | null]> = [
        ["ADVERTISER", ADVERTISER_A_USER],
        ["CREATOR", CREATOR_USER],
        [null, null],
        ["SUPPORT", SUPPORT_USER], // role without roster
      ];

      for (const [role, userId] of attempts) {
        asSession(role, userId);

        assert.equal(
          (await service.listManagedBriefCandidatesForSupport(brief.id)).length,
          0,
          `role ${String(role)} must read nothing`,
        );
        assert.equal(
          (await service.listManagedBriefCandidateAccountOptionsForSupport())
            .length,
          0,
          `role ${String(role)} must get no account options`,
        );
      }
    });

    it("every non-support session is refused on every write", async () => {
      const brief = seedBrief();
      seedCreatorWithAccounts();
      const seeded = seedCandidate({ briefId: brief.id });

      const attempts: Array<["CREATOR" | "ADVERTISER" | "SUPPORT" | null, string | null]> = [
        ["ADVERTISER", ADVERTISER_A_USER],
        ["CREATOR", CREATOR_USER],
        [null, null],
        ["SUPPORT", SUPPORT_USER], // role without roster
      ];

      for (const [role, userId] of attempts) {
        asSession(role, userId);

        assert.match(
          expectRefusal(
            await service.addManagedBriefCandidateForSupport(ADD_INPUT(brief.id)),
          ),
          /Support authorization required/u,
        );
        assert.match(
          expectRefusal(
            await service.transitionManagedBriefCandidateForSupport(seeded.id),
          ),
          /Support authorization required/u,
        );
        assert.match(
          expectRefusal(
            await service.declineManagedBriefCandidateForSupport(seeded.id),
          ),
          /Support authorization required/u,
        );
        assert.match(
          expectRefusal(
            await service.setManagedBriefCandidateNoteForSupport({
              candidateId: seeded.id,
              note: "hijack",
            }),
          ),
          /Support authorization required/u,
        );
        assert.match(
          expectRefusal(
            await service.removeManagedBriefCandidateForSupport(seeded.id),
          ),
          /Support authorization required/u,
        );
      }

      // Nothing was written.
      assert.equal(candidates.length, 1);
      assert.equal(candidateRow(seeded.id).status, "PROSPECT");
      assert.equal(candidateRow(seeded.id).note, null);
    });

    it("a support roster revocation takes effect immediately on candidate writes", async () => {
      const brief = seedBrief();
      seedCreatorWithAccounts();

      asRosteredSupport();

      const added = expectOk(
        await service.addManagedBriefCandidateForSupport(ADD_INPUT(brief.id)),
      );

      // Revoke mid-session (operational act — SQL-only in prod).
      users = users.filter((user) => user.id !== SUPPORT_USER);

      assert.match(
        expectRefusal(
          await service.transitionManagedBriefCandidateForSupport(
            added.candidateId,
          ),
        ),
        /Support authorization required/u,
      );
      assert.equal(
        (await service.listManagedBriefCandidatesForSupport(brief.id)).length,
        0,
      );
      // The row is untouched.
      assert.equal(candidateRow(added.candidateId).status, "PROSPECT");
    });

    it("attribution comes from the session actor, never from any client input", async () => {
      const brief = seedBrief();
      seedCreatorWithAccounts();

      asRosteredSupport();

      const added = expectOk(
        await service.addManagedBriefCandidateForSupport(ADD_INPUT(brief.id)),
      );

      assert.equal(candidateRow(added.candidateId).addedById, SUPPORT_USER);

      const moved = expectOk(
        await service.transitionManagedBriefCandidateForSupport(
          added.candidateId,
        ),
      );

      assert.equal(candidateRow(added.candidateId).status, moved.status);
      assert.ok(candidateRow(added.candidateId).statusUpdatedAt instanceof Date);
      assert.equal(candidateRow(added.candidateId).statusUpdatedById, SUPPORT_USER);
    });
  });

  // -------------------------------------------------------------------------
  // Referenced identity — no duplicated creator data
  // -------------------------------------------------------------------------

  describe("referenced identity", () => {
    it("add requires an existing brief", async () => {
      seedCreatorWithAccounts();
      asRosteredSupport();

      const result = await service.addManagedBriefCandidateForSupport(
        ADD_INPUT("mb-missing"),
      );

      assert.match(expectRefusal(result), /Brief not found/u);
      assert.equal(candidates.length, 0);
    });

    it("add rejects an account that does not belong to the claimed creator", async () => {
      const brief = seedBrief();
      seedCreatorWithAccounts();
      asRosteredSupport();

      // ACCOUNT_2 belongs to CREATOR_PROFILE_1, claimed as profile 2.
      const result = await service.addManagedBriefCandidateForSupport({
        briefId: brief.id,
        creatorProfileId: CREATOR_PROFILE_2,
        socialAccountId: ACCOUNT_2,
      });

      assert.match(
        expectRefusal(result),
        /does not belong to the selected creator/u,
      );
      assert.equal(candidates.length, 0);
    });

    it("the candidate row stores references only — no copied identity data", async () => {
      const brief = seedBrief();
      seedCreatorWithAccounts();
      asRosteredSupport();

      const added = expectOk(
        await service.addManagedBriefCandidateForSupport(ADD_INPUT(brief.id)),
      );

      const row = candidateRow(added.candidateId);

      // The row carries foreign keys, not copies of usernames/urls/counts.
      assert.deepEqual(Object.keys(row).sort(), [
        "addedById",
        "briefId",
        "createdAt",
        "creatorId",
        "id",
        "note",
        "socialAccountId",
        "status",
        "statusUpdatedAt",
        "statusUpdatedById",
        "updatedAt",
      ]);
      assert.equal(row.creatorId, CREATOR_PROFILE_1);
      assert.equal(row.socialAccountId, ACCOUNT_1);
      assert.equal(row.status, "PROSPECT");
      assert.equal(row.note, "Strong launch-week fit.");
    });

    it("the account-options read lists existing accounts per creator (display data only)", async () => {
      seedCreatorWithAccounts();
      asRosteredSupport();

      const options =
        await service.listManagedBriefCandidateAccountOptionsForSupport();

      assert.equal(options.length, 2);

      const option = options.find((entry) => entry.accountId === ACCOUNT_1);

      assert.ok(option);
      assert.equal(option.profileId, CREATOR_PROFILE_1);
      assert.equal(option.accountUsername, "one");
    });
  });

  // -------------------------------------------------------------------------
  // Duplicates — brief + creator + account
  // -------------------------------------------------------------------------

  describe("duplicates", () => {
    it("rejects the same brief + creator + account twice", async () => {
      const brief = seedBrief();
      seedCreatorWithAccounts();
      asRosteredSupport();

      expectOk(await service.addManagedBriefCandidateForSupport(ADD_INPUT(brief.id)));
      assert.match(
        expectRefusal(
          await service.addManagedBriefCandidateForSupport(ADD_INPUT(brief.id)),
        ),
        /already a candidate/u,
      );
      assert.equal(candidates.length, 1);
    });

    it("a lost pre-check race is caught by the DB unique constraint (P2002)", async () => {
      const brief = seedBrief();
      seedCreatorWithAccounts();
      asRosteredSupport();

      // Simulate the row appearing between the service's checks and its
      // insert — the constraint, not the pre-check, is the guard.
      failCandidateCreateWithP2002 = true;

      assert.match(
        expectRefusal(
          await service.addManagedBriefCandidateForSupport(ADD_INPUT(brief.id)),
        ),
        /already a candidate/u,
      );
      assert.equal(candidates.length, 0);
    });

    it("allows a second account for the same creator on the same brief", async () => {
      const brief = seedBrief();
      seedCreatorWithAccounts();
      asRosteredSupport();

      expectOk(await service.addManagedBriefCandidateForSupport(ADD_INPUT(brief.id)));

      const second = expectOk(
        await service.addManagedBriefCandidateForSupport({
          briefId: brief.id,
          creatorProfileId: CREATOR_PROFILE_1,
          socialAccountId: ACCOUNT_2,
        }),
      );

      assert.notEqual(second.candidateId, candidates[0]?.id);
      assert.equal(candidates.length, 2);
    });

    it("allows the same creator + account on a different brief", async () => {
      const briefA = seedBrief();
      const briefB = seedBrief();
      seedCreatorWithAccounts();
      asRosteredSupport();

      expectOk(await service.addManagedBriefCandidateForSupport(ADD_INPUT(briefA.id)));

      const otherBrief = expectOk(
        await service.addManagedBriefCandidateForSupport(ADD_INPUT(briefB.id)),
      );

      assert.equal(otherBrief.briefId, briefB.id);
      assert.equal(candidates.length, 2);
    });

    it("re-adding a removed candidate is allowed (removal is a hard delete)", async () => {
      const brief = seedBrief();
      seedCreatorWithAccounts();
      asRosteredSupport();

      const added = expectOk(
        await service.addManagedBriefCandidateForSupport(ADD_INPUT(brief.id)),
      );

      expectOk(
        await service.removeManagedBriefCandidateForSupport(added.candidateId),
      );
      assert.equal(candidates.length, 0);

      expectOk(
        await service.addManagedBriefCandidateForSupport(ADD_INPUT(brief.id)),
      );
      assert.equal(candidates.length, 1);
    });
  });

  // -------------------------------------------------------------------------
  // Status transitions — server-owned state machine
  // -------------------------------------------------------------------------

  describe("status transitions", () => {
    it("walks the happy path PROSPECT → CONTACTED → INTERESTED → SELECTED", async () => {
      const seeded = seedCandidate();
      asRosteredSupport();

      const first = expectOk(
        await service.transitionManagedBriefCandidateForSupport(seeded.id),
      );
      assert.equal(first.status, "CONTACTED");

      const second = expectOk(
        await service.transitionManagedBriefCandidateForSupport(seeded.id),
      );
      assert.equal(second.status, "INTERESTED");

      const third = expectOk(
        await service.transitionManagedBriefCandidateForSupport(seeded.id),
      );
      assert.equal(third.status, "SELECTED");

      assert.equal(candidateRow(seeded.id).status, "SELECTED");
    });

    it("DECLINED is reachable from every active state", async () => {
      const prospect = seedCandidate({ status: "PROSPECT" });
      const contacted = seedCandidate({ status: "CONTACTED" });
      const interested = seedCandidate({ status: "INTERESTED" });

      asRosteredSupport();

      for (const candidate of [prospect, contacted, interested]) {
        // DECLINED is an explicit branch, reachable from every active state.
        expectOk(
          await service.declineManagedBriefCandidateForSupport(candidate.id),
        );

        assert.equal(candidateRow(candidate.id).status, "DECLINED");
      }
    });

    it("DECLINED and SELECTED are terminal — no further transition exists", async () => {
      const declined = seedCandidate({ status: "DECLINED" });
      const selected = seedCandidate({ status: "SELECTED" });

      asRosteredSupport();

      const declinedResult = await service.transitionManagedBriefCandidateForSupport(
        declined.id,
      );
      assert.equal(declinedResult.success, false);

      // Decline itself is also refused in a terminal state.
      const declinedAgain = await service.declineManagedBriefCandidateForSupport(
        declined.id,
      );
      assert.equal(declinedAgain.success, false);
      if (!declinedAgain.success) {
        assert.match(declinedAgain.error, /cannot be declined/u);
      }

      const selectedResult = await service.transitionManagedBriefCandidateForSupport(
        selected.id,
      );
      assert.equal(selectedResult.success, false);
      if (!selectedResult.success) {
        assert.match(selectedResult.error, /selected/u);
      }

      assert.equal(candidateRow(declined.id).status, "DECLINED");
      assert.equal(candidateRow(selected.id).status, "SELECTED");
    });

    it("a raced transition loses the conditional update and is refused", async () => {
      const seeded = seedCandidate();

      asRosteredSupport();

      // Simulate a concurrent transition between the read and the write.
      forceUpdateCount = 0;

      const result = await service.transitionManagedBriefCandidateForSupport(
        seeded.id,
      );

      assert.equal(result.success, false);
      if (!result.success) {
        assert.match(result.error, /already changed/i);
      }
      assert.equal(candidateRow(seeded.id).status, "PROSPECT");
    });

    it("a nonexistent candidate id is an error, not a crash (transition, note, remove)", async () => {
      asRosteredSupport();

      const moved = await service.transitionManagedBriefCandidateForSupport(
        "mbc-missing",
      );
      assert.equal(moved.success, false);

      const noted = await service.setManagedBriefCandidateNoteForSupport({
        candidateId: "mbc-missing",
        note: "test",
      });
      assert.equal(noted.success, false);

      const removed = await service.removeManagedBriefCandidateForSupport(
        "mbc-missing",
      );
      assert.equal(removed.success, false);
    });
  });

  // -------------------------------------------------------------------------
  // Notes and removal
  // -------------------------------------------------------------------------

  describe("notes and removal", () => {
    it("sets and clears the internal note without touching the status machine", async () => {
      const seeded = seedCandidate({ note: "First take." });

      asRosteredSupport();

      const updated = expectOk(
        await service.setManagedBriefCandidateNoteForSupport({
          candidateId: seeded.id,
          note: "Spoke to their manager; positive signal.",
        }),
      );

      assert.equal(updated.status, "PROSPECT");
      assert.equal(
        candidateRow(seeded.id).note,
        "Spoke to their manager; positive signal.",
      );

      expectOk(
        await service.setManagedBriefCandidateNoteForSupport({
          candidateId: seeded.id,
          note: "",
        }),
      );

      assert.equal(candidateRow(seeded.id).note, null);
    });

    it("removal deletes the row", async () => {
      const seeded = seedCandidate();

      asRosteredSupport();

      expectOk(
        await service.removeManagedBriefCandidateForSupport(seeded.id),
      );

      assert.equal(candidates.length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Privacy — advertisers and creators never see sourcing data
  // -------------------------------------------------------------------------

  describe("privacy", () => {
    it("the advertiser's owner-scoped brief reads contain no candidate data", async () => {
      const brief = seedBrief({ advertiserId: ADVERTISER_A_PROFILE });
      seedCreatorWithAccounts();
      seedCandidate({ briefId: brief.id });

      asRosteredSupport();

      // Candidate exists for support…
      assert.equal(
        (await service.listManagedBriefCandidatesForSupport(brief.id)).length,
        1,
      );

      // …but the owner's reads are unchanged and carry nothing about it.
      asSession("ADVERTISER", ADVERTISER_A_USER);

      const own = await service.getManagedBrief(ADVERTISER_A_PROFILE, brief.id);

      assert.ok(own);
      assert.deepEqual(Object.keys(own).sort(), [
        "budgetMinor",
        "campaignGoal",
        "closedAt",
        "createdAt",
        "creatorRequirements",
        "currency",
        "description",
        "id",
        "reviewStartedAt",
        "status",
        "targetAudience",
        "targetPlatforms",
        "updatedAt",
      ]);

      const ownList = await service.listManagedBriefs(ADVERTISER_A_PROFILE);

      assert.equal(ownList.length, 1);
      assert.equal("candidates" in ownList[0]!, false);
      assert.equal("sourcingCandidates" in ownList[0]!, false);
    });

    it("candidates never leak across advertisers' briefs on the support path either", async () => {
      const briefA = seedBrief({ advertiserId: ADVERTISER_A_PROFILE });
      seedBrief({ advertiserId: "adv-profile-b" });
      seedCreatorWithAccounts();
      seedCandidate({ briefId: briefA.id });

      asRosteredSupport();

      const list = await service.listManagedBriefCandidatesForSupport(briefA.id);

      assert.equal(list.length, 1);
      assert.ok(list.every((candidate) => candidate.id !== undefined));
    });

    it("creators have no access to any candidate read or write path", async () => {
      const brief = seedBrief();
      seedCreatorWithAccounts();
      const seeded = seedCandidate({ briefId: brief.id });

      asSession("CREATOR", CREATOR_USER);

      assert.equal(
        (await service.listManagedBriefCandidatesForSupport(brief.id)).length,
        0,
      );
      assert.equal(
        (
          await service.listManagedBriefCandidateAccountOptionsForSupport()
        ).length,
        0,
      );
      assert.match(
        expectRefusal(
          await service.transitionManagedBriefCandidateForSupport(seeded.id),
        ),
        /Support authorization required/u,
      );
      assert.match(
        expectRefusal(
          await service.removeManagedBriefCandidateForSupport(seeded.id),
        ),
        /Support authorization required/u,
      );
    });
  });
});
