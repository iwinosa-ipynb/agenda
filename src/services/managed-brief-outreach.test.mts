import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Agenda Managed (V1, slice 4) — internal outreach tracking for sourcing
 * candidates (mark contacted / record response / outreach note).
 *
 * Same harness as the slice 1–3 suites: Prisma replaced with an in-memory
 * stub via node:test module mocking (no DATABASE_URL), "server-only" and
 * next/navigation mocked. The session seam mocks @/lib/auth so the REAL
 * authz guards (getSupportActor) run their actual logic — the Stage 14D
 * authorization matrix is exercised end to end, not stubbed.
 *
 * Covers:
 *   - support authorization (advertisers, creators, anonymous, roster-less
 *     SUPPORT all fail closed on every outreach read/write);
 *   - valid transitions: CONTACTED (record created) → INTERESTED | DECLINED;
 *   - invalid transitions: response before contact, response after a
 *     terminal response, wrong-state moves;
 *   - repeated/concurrent actions: duplicate "mark contacted" refused by the
 *     pre-check AND by the DB unique constraint (P2002); raced response
 *     refused by the conditional update;
 *   - roster revocation takes effect immediately;
 *   - advertiser privacy: no advertiser-facing read contains outreach data;
 *   - creator isolation: no creator path reaches any outreach function.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma stub
// ---------------------------------------------------------------------------

type OutreachStatus = "CONTACTED" | "INTERESTED" | "DECLINED";

type OutreachRow = {
  id: string;
  candidateId: string;
  status: OutreachStatus;
  contactedAt: Date;
  respondedAt: Date | null;
  note: string | null;
  contactedById: string;
  respondedById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type CandidateRow = {
  id: string;
  briefId: string;
  creatorId: string;
  socialAccountId: string;
  status: string;
  note: string | null;
  addedById: string;
  statusUpdatedAt: Date | null;
  statusUpdatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type BriefRow = { id: string; advertiserId: string };
type UserRow = { id: string; supportRosterMember: boolean };

let outreaches: OutreachRow[] = [];
let candidates: CandidateRow[] = [];
let briefs: BriefRow[] = [];
let users: UserRow[] = [];
let nextId = 1;
// When true, outreach.create rejects with a Prisma-shaped P2002 (lost
// "mark contacted" race against the candidateId unique constraint).
let failOutreachCreateWithP2002 = false;
// Overrides outreach.updateMany's count (0 = simulated lost response race).
let forceOutreachUpdateCount: number | null = null;

function resetDb(): void {
  outreaches = [];
  candidates = [];
  briefs = [];
  users = [];
  nextId = 1;
  failOutreachCreateWithP2002 = false;
  forceOutreachUpdateCount = null;
}

function outreachMatches(
  row: OutreachRow,
  where: Record<string, unknown>,
): boolean {
  if (where.id !== undefined && row.id !== where.id) {
    return false;
  }

  if (where.candidateId !== undefined && row.candidateId !== where.candidateId) {
    return false;
  }

  if (where.status !== undefined && row.status !== where.status) {
    return false;
  }

  return true;
}

const prismaStub = {
  managedBriefCandidateOutreach: {
    create: async (args: { data: Record<string, unknown> }) => {
      const data = args.data;

      // candidateId is unique — the DB-level duplicate-contact guard.
      const duplicate = outreaches.some(
        (row) => row.candidateId === data.candidateId,
      );

      if (duplicate || failOutreachCreateWithP2002) {
        return Promise.reject({ code: "P2002" });
      }

      const now = new Date();
      const row: OutreachRow = {
        id: `mbo-${nextId++}`,
        candidateId: String(data.candidateId),
        status: (data.status as OutreachStatus) ?? "CONTACTED",
        contactedAt: data.contactedAt as Date,
        respondedAt: (data.respondedAt as Date | null) ?? null,
        note: (data.note as string | null) ?? null,
        contactedById: String(data.contactedById),
        respondedById: (data.respondedById as string | null) ?? null,
        createdAt: now,
        updatedAt: now,
      };

      outreaches.push(row);

      return structuredClone(row);
    },
    findFirst: async (args: {
      where: Record<string, unknown>;
      select?: Record<string, unknown>;
    }) => {
      const row = outreaches.find((candidate) =>
        outreachMatches(candidate, args.where),
      );

      if (!row) {
        return null;
      }

      // Emulate the relation join the service selects.
      return {
        ...structuredClone(row),
        candidate: { briefId: candidateBriefId(row.candidateId) },
      };
    },
    updateMany: async (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      if (forceOutreachUpdateCount !== null) {
        const forced = forceOutreachUpdateCount;
        forceOutreachUpdateCount = null;

        return { count: forced };
      }

      let count = 0;

      for (const row of outreaches) {
        if (!outreachMatches(row, args.where)) {
          continue;
        }

        Object.assign(row, structuredClone(args.data));
        count += 1;
      }

      return { count };
    },
    update: async (args: {
      where: { candidateId: string };
      data: Record<string, unknown>;
    }) => {
      const row = outreaches.find(
        (candidate) => candidate.candidateId === args.where.candidateId,
      );

      if (!row) {
        return Promise.reject({ code: "P2025" });
      }

      Object.assign(row, structuredClone(args.data));

      return {
        ...structuredClone(row),
        candidate: { briefId: candidateBriefId(row.candidateId) },
      };
    },
  },
  managedBriefSourcingCandidate: {
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const row = candidates.find(
        (candidate) => candidate.id === (args.where as { id?: string }).id,
      );

      if (!row) {
        return null;
      }

      return {
        ...structuredClone(row),
        outreach: outreaches.find(
          (outreach) => outreach.candidateId === row.id,
        )
          ? { id: outreaches.find((o) => o.candidateId === row.id)!.id }
          : null,
      };
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

      if (!row) {
        return null;
      }

      // Emulate the full owner-detail shape the service maps.
      const now = new Date();

      return {
        id: row.id,
        advertiserId: row.advertiserId,
        campaignGoal: "Launch-week awareness",
        description: "A launch-week push.",
        budgetMinor: 50_000_000n,
        currency: "NGN",
        targetAudience: "Men 18-34 into fitness",
        targetPlatforms: ["TIKTOK"],
        creatorRequirements: null,
        status: "IN_REVIEW",
        reviewStartedAt: null,
        closedAt: null,
        createdAt: now,
        updatedAt: now,
      };
    },
    findMany: async (args: { where?: Record<string, unknown> }) => {
      const where = (args.where ?? {}) as { advertiserId?: string };

      return briefs
        .filter(
          (candidate) =>
            where.advertiserId === undefined ||
            candidate.advertiserId === where.advertiserId,
        )
        .map((row) => ({
          id: row.id,
          campaignGoal: "Launch-week awareness",
          budgetMinor: 50_000_000n,
          currency: "NGN",
          targetAudience: "Men 18-34 into fitness",
          targetPlatforms: ["TIKTOK"],
          status: "IN_REVIEW",
          createdAt: new Date(),
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

function candidateBriefId(candidateId: string): string {
  const row = candidates.find((candidate) => candidate.id === candidateId);

  return row ? row.briefId : "missing-brief";
}

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

let service: Service;

const ADVERTISER_A_PROFILE = "adv-profile-a";
const ADVERTISER_A_USER = "user-advertiser-a";
const SUPPORT_USER = "user-support-1";
const CREATOR_USER = "user-creator-1";

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

function asRosteredSupport(): void {
  asSession("SUPPORT", SUPPORT_USER);
  putOnRoster(SUPPORT_USER);
}

function seedBrief(): BriefRow {
  const row = { id: `mb-${nextId++}`, advertiserId: ADVERTISER_A_PROFILE };

  briefs.push(row);

  return row;
}

function seedCandidate(overrides: Partial<CandidateRow> = {}): CandidateRow {
  const now = new Date();
  const row: CandidateRow = {
    id: `mbc-${nextId++}`,
    briefId: `mb-${nextId++}`,
    creatorId: "creator-profile-1",
    socialAccountId: "social-account-1",
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

  // Keep brief rows present so the join works.
  if (!briefs.some((brief) => brief.id === row.briefId)) {
    briefs.push({ id: row.briefId, advertiserId: ADVERTISER_A_PROFILE });
  }

  return row;
}

function seedOutreach(overrides: Partial<OutreachRow> = {}): OutreachRow {
  const now = new Date();
  const row: OutreachRow = {
    id: `mbo-${nextId++}`,
    candidateId: `mbc-${nextId++}`,
    status: "CONTACTED",
    contactedAt: now,
    respondedAt: null,
    note: null,
    contactedById: SUPPORT_USER,
    respondedById: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };

  outreaches.push(row);

  if (!candidates.some((candidate) => candidate.id === row.candidateId)) {
    seedCandidate({ id: row.candidateId, status: "CONTACTED" });
  }

  return row;
}

type OutreachResult = Awaited<
  ReturnType<Service["contactManagedBriefCandidateForSupport"]>
>;

function expectOk(
  result: OutreachResult,
): { outreachId: string; candidateId: string; briefId: string; status: string } {
  assert.equal(result.success, true);

  return (
    result as {
      success: true;
      data: {
        outreachId: string;
        candidateId: string;
        briefId: string;
        status: string;
      };
    }
  ).data;
}

function expectRefusal(result: OutreachResult): string {
  assert.equal(result.success, false);

  return (result as { success: false; error: string }).error;
}

function outreachRow(candidateId: string): OutreachRow {
  const row = outreaches.find((candidate) => candidate.candidateId === candidateId);

  assert.ok(row, "outreach row should exist");

  return row;
}

const CONTACT_INPUT = (candidateId: string) => ({
  candidateId,
  note: "Reached out on X DMs." as string | undefined,
});

describe("Agenda Managed V1 — candidate outreach tracking", () => {
  before(async () => {
    service = await import("@/services/managed-brief.service");
  });

  beforeEach(() => {
    resetDb();
    asSession(null, null);
  });

  // -------------------------------------------------------------------------
  // Support authorization
  // -------------------------------------------------------------------------

  describe("authorization", () => {
    it("a rostered support operator can log outreach and record responses", async () => {
      const brief = seedBrief();
      const candidate = seedCandidate({ briefId: brief.id });

      asRosteredSupport();

      const contacted = expectOk(
        await service.contactManagedBriefCandidateForSupport(CONTACT_INPUT(candidate.id)),
      );

      assert.equal(contacted.status, "CONTACTED");
      assert.equal(contacted.briefId, brief.id);

      const responded = expectOk(
        await service.recordManagedBriefOutreachInterestedForSupport({
          candidateId: candidate.id,
        }),
      );

      assert.equal(responded.status, "INTERESTED");
    });

    it("every non-support session is refused on every outreach write", async () => {
      const candidate = seedCandidate();
      const contacted = seedOutreach({ status: "CONTACTED" });

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
            await service.contactManagedBriefCandidateForSupport(
              CONTACT_INPUT(candidate.id),
            ),
          ),
          /Support authorization required/u,
        );
        assert.match(
          expectRefusal(
            await service.recordManagedBriefOutreachInterestedForSupport({
              candidateId: contacted.candidateId,
            }),
          ),
          /Support authorization required/u,
        );
        assert.match(
          expectRefusal(
            await service.recordManagedBriefOutreachDeclinedForSupport({
              candidateId: contacted.candidateId,
            }),
          ),
          /Support authorization required/u,
        );
        assert.match(
          expectRefusal(
            await service.setManagedBriefOutreachNoteForSupport({
              candidateId: contacted.candidateId,
              note: "hijack",
            }),
          ),
          /Support authorization required/u,
        );
      }

      // Nothing was written.
      assert.equal(outreaches.length, 1);
      assert.equal(outreachRow(contacted.candidateId).status, "CONTACTED");
    });

    it("a support roster revocation takes effect immediately", async () => {
      const candidate = seedCandidate();

      asRosteredSupport();

      expectOk(
        await service.contactManagedBriefCandidateForSupport(CONTACT_INPUT(candidate.id)),
      );

      // Revoke mid-session (operational act — SQL-only in prod).
      users = users.filter((user) => user.id !== SUPPORT_USER);

      assert.match(
        expectRefusal(
          await service.recordManagedBriefOutreachInterestedForSupport({
            candidateId: candidate.id,
          }),
        ),
        /Support authorization required/u,
      );
      assert.match(
        expectRefusal(
          await service.setManagedBriefOutreachNoteForSupport({
            candidateId: candidate.id,
            note: "post-revocation",
          }),
        ),
        /Support authorization required/u,
      );

      // The record is untouched.
      assert.equal(outreachRow(candidate.id).status, "CONTACTED");
      assert.equal(outreachRow(candidate.id).note, "Reached out on X DMs.");
      assert.equal(outreachRow(candidate.id).respondedAt, null);
    });

    it("attribution comes from the session actor, never from client input", async () => {
      const candidate = seedCandidate();

      asRosteredSupport();

      expectOk(
        await service.contactManagedBriefCandidateForSupport(CONTACT_INPUT(candidate.id)),
      );

      const row = outreachRow(candidate.id);

      assert.equal(row.contactedById, SUPPORT_USER);
      assert.ok(row.contactedAt instanceof Date);

      expectOk(
        await service.recordManagedBriefOutreachDeclinedForSupport({
          candidateId: candidate.id,
        }),
      );

      assert.equal(outreachRow(candidate.id).respondedById, SUPPORT_USER);
      assert.ok(outreachRow(candidate.id).respondedAt instanceof Date);
    });
  });

  // -------------------------------------------------------------------------
  // Valid transitions
  // -------------------------------------------------------------------------

  describe("valid transitions", () => {
    it("mark contacted creates exactly one record with CONTACTED + contactedAt", async () => {
      const candidate = seedCandidate();

      asRosteredSupport();

      const result = expectOk(
        await service.contactManagedBriefCandidateForSupport(CONTACT_INPUT(candidate.id)),
      );

      const row = outreachRow(candidate.id);

      assert.equal(row.status, "CONTACTED");
      assert.ok(row.contactedAt instanceof Date);
      assert.equal(row.respondedAt, null);
      assert.equal(row.note, "Reached out on X DMs.");
      assert.equal(result.outreachId, row.id);
    });

    it("CONTACTED → INTERESTED and CONTACTED → DECLINED are the only legal response moves", async () => {
      const a = seedCandidate();
      const b = seedCandidate();

      asRosteredSupport();

      expectOk(await service.contactManagedBriefCandidateForSupport(CONTACT_INPUT(a.id)));
      expectOk(await service.contactManagedBriefCandidateForSupport(CONTACT_INPUT(b.id)));

      expectOk(
        await service.recordManagedBriefOutreachInterestedForSupport({
          candidateId: a.id,
        }),
      );
      expectOk(
        await service.recordManagedBriefOutreachDeclinedForSupport({
          candidateId: b.id,
        }),
      );

      assert.equal(outreachRow(a.id).status, "INTERESTED");
      assert.equal(outreachRow(b.id).status, "DECLINED");
    });

    it("the response note is stored atomically with the response", async () => {
      const candidate = seedCandidate();

      asRosteredSupport();

      expectOk(await service.contactManagedBriefCandidateForSupport(CONTACT_INPUT(candidate.id)));
      expectOk(
        await service.recordManagedBriefOutreachInterestedForSupport({
          candidateId: candidate.id,
          note: "Keen; asked for timing.",
        }),
      );

      assert.equal(outreachRow(candidate.id).note, "Keen; asked for timing.");
    });
  });

  // -------------------------------------------------------------------------
  // Invalid transitions
  // -------------------------------------------------------------------------

  describe("invalid transitions", () => {
    it("recording a response before contact is refused", async () => {
      const candidate = seedCandidate();

      asRosteredSupport();

      assert.match(
        expectRefusal(
          await service.recordManagedBriefOutreachInterestedForSupport({
            candidateId: candidate.id,
          }),
        ),
        /not been marked contacted/u,
      );
      assert.match(
        expectRefusal(
          await service.recordManagedBriefOutreachDeclinedForSupport({
            candidateId: candidate.id,
          }),
        ),
        /not been marked contacted/u,
      );
      assert.equal(outreaches.length, 0);
    });

    it("a second response after INTERESTED is refused (terminal)", async () => {
      const candidate = seedCandidate();
      seedOutreach({ candidateId: candidate.id, status: "INTERESTED", respondedAt: new Date() });

      asRosteredSupport();

      assert.match(
        expectRefusal(
          await service.recordManagedBriefOutreachDeclinedForSupport({
            candidateId: candidate.id,
          }),
        ),
        /cannot change again/u,
      );
      assert.equal(outreachRow(candidate.id).status, "INTERESTED");
    });

    it("a second response after DECLINED is refused (terminal)", async () => {
      const candidate = seedCandidate();
      seedOutreach({ candidateId: candidate.id, status: "DECLINED", respondedAt: new Date() });

      asRosteredSupport();

      assert.match(
        expectRefusal(
          await service.recordManagedBriefOutreachInterestedForSupport({
            candidateId: candidate.id,
          }),
        ),
        /cannot change again/u,
      );
      assert.equal(outreachRow(candidate.id).status, "DECLINED");
    });

    it("a nonexistent candidate id is an error, not a crash", async () => {
      asRosteredSupport();

      assert.equal(
        (
          await service.contactManagedBriefCandidateForSupport(
            CONTACT_INPUT("mbc-missing"),
          )
        ).success,
        false,
      );
      assert.equal(
        (
          await service.recordManagedBriefOutreachInterestedForSupport({
            candidateId: "mbc-missing",
          })
        ).success,
        false,
      );
      assert.equal(
        (
          await service.setManagedBriefOutreachNoteForSupport({
            candidateId: "mbc-missing",
            note: "x",
          })
        ).success,
        false,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Repeated / concurrent actions
  // -------------------------------------------------------------------------

  describe("repeated and concurrent actions", () => {
    it("a repeated 'mark contacted' is refused by the service pre-check", async () => {
      const candidate = seedCandidate();

      asRosteredSupport();

      expectOk(await service.contactManagedBriefCandidateForSupport(CONTACT_INPUT(candidate.id)));

      assert.match(
        expectRefusal(
          await service.contactManagedBriefCandidateForSupport(CONTACT_INPUT(candidate.id)),
        ),
        /already been marked contacted/u,
      );
      assert.equal(outreaches.length, 1);
    });

    it("a lost 'mark contacted' race is caught by the DB unique constraint (P2002)", async () => {
      const candidate = seedCandidate();

      asRosteredSupport();

      // Simulate a concurrent record appearing between the pre-check and the
      // insert — the constraint, not the pre-check, is the guard.
      failOutreachCreateWithP2002 = true;

      assert.match(
        expectRefusal(
          await service.contactManagedBriefCandidateForSupport(CONTACT_INPUT(candidate.id)),
        ),
        /already been marked contacted/u,
      );
      assert.equal(outreaches.length, 0);
    });

    it("a raced response loses the conditional update and is refused", async () => {
      const candidate = seedCandidate();
      seedOutreach({ candidateId: candidate.id, status: "CONTACTED" });

      asRosteredSupport();

      // Simulate a concurrent response between the read and the write.
      forceOutreachUpdateCount = 0;

      assert.match(
        expectRefusal(
          await service.recordManagedBriefOutreachInterestedForSupport({
            candidateId: candidate.id,
          }),
        ),
        /already has a response/u,
      );
      assert.equal(outreachRow(candidate.id).status, "CONTACTED");
    });
  });

  // -------------------------------------------------------------------------
  // Outreach note
  // -------------------------------------------------------------------------

  describe("outreach note", () => {
    it("sets and clears the note without touching the status machine", async () => {
      const candidate = seedCandidate();
      seedOutreach({ candidateId: candidate.id, status: "INTERESTED", respondedAt: new Date() });

      asRosteredSupport();

      expectOk(
        await service.setManagedBriefOutreachNoteForSupport({
          candidateId: candidate.id,
          note: "Follow up next quarter.",
        }),
      );

      assert.equal(outreachRow(candidate.id).note, "Follow up next quarter.");
      assert.equal(outreachRow(candidate.id).status, "INTERESTED");

      expectOk(
        await service.setManagedBriefOutreachNoteForSupport({
          candidateId: candidate.id,
          note: "",
        }),
      );

      assert.equal(outreachRow(candidate.id).note, null);
      // Terminal state preserved.
      assert.equal(outreachRow(candidate.id).status, "INTERESTED");
    });
  });

  // -------------------------------------------------------------------------
  // Advertiser privacy
  // -------------------------------------------------------------------------

  describe("advertiser privacy", () => {
    it("advertiser-facing brief reads contain no outreach or candidate data", async () => {
      const brief = seedBrief();
      const candidate = seedCandidate({ briefId: brief.id });

      asRosteredSupport();

      expectOk(await service.contactManagedBriefCandidateForSupport(CONTACT_INPUT(candidate.id)));
      expectOk(
        await service.recordManagedBriefOutreachInterestedForSupport({
          candidateId: candidate.id,
          note: "Internal detail advertisers must never see.",
        }),
      );

      // Switch to the owning advertiser.
      asSession("ADVERTISER", ADVERTISER_A_USER);

      const own = await service.getManagedBrief(ADVERTISER_A_PROFILE, brief.id);

      assert.ok(own);
      // The owner read model carries none of the sourcing/outreach surface.
      assert.equal("outreach" in own, false);
      assert.equal("candidates" in own, false);
      assert.equal("sourcingCandidates" in own, false);
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
    });

    it("the support candidate read is the only read that exposes outreach", async () => {
      const brief = seedBrief();
      const candidate = seedCandidate({ briefId: brief.id });

      asRosteredSupport();

      expectOk(await service.contactManagedBriefCandidateForSupport(CONTACT_INPUT(candidate.id)));

      // The candidate list is the one internal read that carries outreach.
      // (Its shape is asserted in the slice 3 suite; here we assert the
      // advertiser's summary list remains outreach-free.)
      asSession("ADVERTISER", ADVERTISER_A_USER);

      const ownList = await service.listManagedBriefs(ADVERTISER_A_PROFILE);

      assert.equal(ownList.length, 1);
      assert.equal("outreach" in ownList[0]!, false);
    });
  });

  // -------------------------------------------------------------------------
  // Creator isolation
  // -------------------------------------------------------------------------

  describe("creator isolation", () => {
    it("creators cannot reach any outreach read or write", async () => {
      const candidate = seedCandidate();
      const contacted = seedOutreach({ candidateId: candidate.id, status: "CONTACTED" });

      asSession("CREATOR", CREATOR_USER);

      assert.match(
        expectRefusal(
          await service.contactManagedBriefCandidateForSupport(CONTACT_INPUT(candidate.id)),
        ),
        /Support authorization required/u,
      );
      assert.match(
        expectRefusal(
          await service.recordManagedBriefOutreachInterestedForSupport({
            candidateId: contacted.candidateId,
          }),
        ),
        /Support authorization required/u,
      );
      assert.match(
        expectRefusal(
          await service.recordManagedBriefOutreachDeclinedForSupport({
            candidateId: contacted.candidateId,
          }),
        ),
        /Support authorization required/u,
      );
      assert.match(
        expectRefusal(
          await service.setManagedBriefOutreachNoteForSupport({
            candidateId: contacted.candidateId,
            note: "creator wrote this",
          }),
        ),
        /Support authorization required/u,
      );

      // Nothing changed.
      assert.equal(outreachRow(contacted.candidateId).status, "CONTACTED");
      assert.equal(outreachRow(contacted.candidateId).note, null);
    });
  });
});
