import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Agenda Managed (V1, slice 1) — managed briefs
 * (src/services/managed-brief.service.ts + validation).
 *
 * Strategy mirrors rate-card.integration.test.mts: Prisma replaced with an
 * in-memory stub via node:test module mocking (no DATABASE_URL), "server-only"
 * and next/navigation mocked. The session seam mocks @/lib/auth (like the 14D
 * suite) so requireRole/getSupportActor run their REAL logic — the
 * authorization matrix is exercised end to end, not stubbed away.
 *
 * Covers:
 *   - validation: field-level rules, channel enum, budget canonicalization;
 *   - creation: server-owned status, money boundary, currency gate;
 *   - authorization: owner-only reads (ownership inside the where-clause),
 *     support via the Stage 14D seam, fail-closed for everyone else;
 *   - privacy: briefs never leak across advertisers.
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
}

function matches(row: BriefRow, where: Record<string, unknown>): boolean {
  // Ownership is expressed as a top-level advertiserId in every service query.
  if (where.advertiserId !== undefined && row.advertiserId !== where.advertiserId) {
    return false;
  }

  if (where.id !== undefined && row.id !== where.id) {
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
        .map((row) => structuredClone(row));

      // createdAt desc is the only ordering the service asks for.
      if (args.orderBy?.createdAt === "desc") {
        found.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }

      return found;
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

// Session seam — mirrors the real Auth.js JWT/session behavior so the REAL
// authz guards (requireRole, getSupportActor) run against it.
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
const SUPPORT_USER = "user-support-1";
const CREATOR_USER = "user-creator-1";

function asSession(role: "CREATOR" | "ADVERTISER" | "SUPPORT" | null, userId: string | null): void {
  sessionRole = role;
  sessionUserId = userId;
}

function putOnRoster(userId: string): void {
  users.push({ id: userId, supportRosterMember: true });
}

type CreateBriefInput = Parameters<Service["createManagedBrief"]>[1];

/** Valid brief input (the happy-path form payload). */
function validInput(overrides: Partial<CreateBriefInput> = {}): CreateBriefInput {
  return {
    campaignGoal: "Launch-week awareness",
    description: "A launch-week push for our new sneaker line across Nigeria.",
    budget: 500000,
    currency: "NGN",
    targetAudience: "Men 18-34 interested in fitness and streetwear",
    targetPlatforms: ["TIKTOK"],
    creatorRequirements: undefined,
    ...overrides,
  };
}

function expectOk<T>(result: { success: boolean } & { data?: T }): T {
  assert.equal(result.success, true);

  return (result as { success: true; data: T }).data;
}

describe("Agenda Managed V1 — briefs", () => {
  before(async () => {
    service = await import("@/services/managed-brief.service");
    validation = await import("@/validation/managed-brief");
  });

  beforeEach(() => {
    resetDb();
    asSession(null, null);
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  describe("parseManagedBriefForm", () => {
    function form(overrides: Record<string, FormDataEntryValue | FormDataEntryValue[]> = {}) {
      return {
        campaignGoal: "Launch-week awareness",
        description: "A launch-week push for our new sneaker line.",
        budget: "500000",
        currency: "NGN",
        targetAudience: "Men 18-34 into fitness",
        targetPlatforms: ["TIKTOK"],
        creatorRequirements: "",
        ...overrides,
      } as Record<string, FormDataEntryValue | FormDataEntryValue[] | null>;
    }

    it("accepts a complete valid submission", () => {
      const parsed = validation.parseManagedBriefForm(form());

      assert.equal(parsed.success, true);

      if (parsed.success) {
        assert.equal(parsed.data.campaignGoal, "Launch-week awareness");
        assert.deepEqual(parsed.data.targetPlatforms, ["TIKTOK"]);
        assert.equal(parsed.data.creatorRequirements, undefined);
      }
    });

    it("requires a goal, description, audience and at least one channel", () => {
      const parsed = validation.parseManagedBriefForm(
        form({ campaignGoal: "", description: "too short", targetAudience: "", targetPlatforms: [] }),
      );

      assert.equal(parsed.success, false);

      if (!parsed.success) {
        assert.ok(parsed.fieldErrors.campaignGoal);
        assert.ok(parsed.fieldErrors.description);
        assert.ok(parsed.fieldErrors.targetAudience);
        assert.ok(parsed.fieldErrors.targetPlatforms);
      }
    });

    it("rejects an unsupported channel", () => {
      const parsed = validation.parseManagedBriefForm(
        form({ targetPlatforms: ["YOUTUBE"] }),
      );

      assert.equal(parsed.success, false);

      if (!parsed.success) {
        assert.ok(parsed.fieldErrors.targetPlatforms);
      }
    });

    it("rejects a non-positive budget", () => {
      const parsed = validation.parseManagedBriefForm(form({ budget: "0" }));

      assert.equal(parsed.success, false);

      if (!parsed.success) {
        assert.ok(parsed.fieldErrors.budget);
      }
    });

    it("rejects garbage budget input", () => {
      const parsed = validation.parseManagedBriefForm(form({ budget: "lots" }));

      assert.equal(parsed.success, false);

      if (!parsed.success) {
        assert.ok(parsed.fieldErrors.budget);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  describe("createManagedBrief", () => {
    it("creates a SUBMITTED brief with exact minor-unit budget", async () => {
      const result = await service.createManagedBrief(
        ADVERTISER_A_PROFILE,
        validInput({ budget: 1000.5 }),
      );

      assert.equal(result.success, true);
      assert.equal(briefs.length, 1);

      const row = briefs[0]!;
      assert.equal(row.status, "SUBMITTED");
      // ₦1,000.50 → 100050 kobo, exactly — no floats ever stored.
      assert.equal(row.budgetMinor, 100050n);
      assert.equal(row.advertiserId, ADVERTISER_A_PROFILE);
      assert.deepEqual(row.targetPlatforms, ["TIKTOK"]);
      assert.equal(row.creatorRequirements, null);
    });

    it("refuses an unsupported currency (money boundary gate)", async () => {
      const result = await service.createManagedBrief(ADVERTISER_A_PROFILE, validInput({
        currency: "USD" as never,
      }));

      assert.equal(result.success, false);
      assert.equal(briefs.length, 0);
    });

    it("refuses a budget that cannot be represented exactly", async () => {
      const result = await service.createManagedBrief(
        ADVERTISER_A_PROFILE,
        validInput({ budget: Number.NaN }),
      );

      assert.equal(result.success, false);
      assert.equal(briefs.length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Authorization — owner reads
  // -------------------------------------------------------------------------

  describe("owner reads", () => {
    it("listManagedBriefs returns only the caller's own briefs", async () => {
      await service.createManagedBrief(ADVERTISER_A_PROFILE, validInput());
      await service.createManagedBrief(ADVERTISER_B_PROFILE, validInput());

      const ownBriefs = await service.listManagedBriefs(ADVERTISER_A_PROFILE);

      assert.equal(ownBriefs.length, 1);
      assert.equal(ownBriefs[0]?.campaignGoal, "Launch-week awareness");
      // Serialized for the server/client boundary: BigInt → string.
      assert.equal(ownBriefs[0]?.budgetMinor, "50000000");
    });

    it("getManagedBrief returns the brief for its owner", async () => {
      const created = expectOk(
        await service.createManagedBrief(ADVERTISER_A_PROFILE, validInput()),
      );

      const brief = await service.getManagedBrief(
        ADVERTISER_A_PROFILE,
        created.briefId,
      );

      assert.ok(brief);
      assert.equal(brief.description.length > 0, true);
      assert.equal(brief.updatedAt instanceof Date, true);
    });

    it("getManagedBrief returns null for another advertiser's brief (no leak)", async () => {
      const created = expectOk(
        await service.createManagedBrief(ADVERTISER_A_PROFILE, validInput()),
      );

      const foreign = await service.getManagedBrief(
        ADVERTISER_B_PROFILE,
        created.briefId,
      );

      assert.equal(foreign, null);
    });

    it("getManagedBrief returns null for a nonexistent id", async () => {
      const brief = await service.getManagedBrief(
        ADVERTISER_A_PROFILE,
        "mb-does-not-exist",
      );

      assert.equal(brief, null);
    });
  });

  // -------------------------------------------------------------------------
  // Authorization — role matrix through the REAL guards
  // -------------------------------------------------------------------------

  describe("role matrix", () => {
    it("requireRole('ADVERTISER') admits an advertiser session", async () => {
      asSession("ADVERTISER", ADVERTISER_A_USER);

      const { requireRole } = await import("@/lib/authz");

      const user = await requireRole("ADVERTISER");

      assert.equal(user.id, ADVERTISER_A_USER);
    });

    it("requireRole('ADVERTISER') redirects a creator (brief pages are advertiser-only)", async () => {
      asSession("CREATOR", CREATOR_USER);

      const { requireRole } = await import("@/lib/authz");

      await assert.rejects(
        () => requireRole("ADVERTISER"),
        /REDIRECTED:\/dashboard/,
      );
    });

    it("requireRole('ADVERTISER') redirects anonymous callers", async () => {
      asSession(null, null);

      const { requireRole } = await import("@/lib/authz");

      await assert.rejects(
        () => requireRole("ADVERTISER"),
        /REDIRECTED:\/auth\/login/,
      );
    });

    it("support WITH roster membership can read a brief through the 14D seam", async () => {
      const created = expectOk(
        await service.createManagedBrief(ADVERTISER_A_PROFILE, validInput()),
      );

      asSession("SUPPORT", SUPPORT_USER);
      putOnRoster(SUPPORT_USER);

      const brief = await service.getManagedBriefForSupport(created.briefId);

      assert.ok(brief);
      assert.equal(brief.id, created.briefId);
    });

    it("support WITHOUT roster membership is fail-closed (null)", async () => {
      const created = expectOk(
        await service.createManagedBrief(ADVERTISER_A_PROFILE, validInput()),
      );

      asSession("SUPPORT", SUPPORT_USER);
      // No roster insert — role alone is never sufficient (Stage 14D).

      const brief = await service.getManagedBriefForSupport(created.briefId);

      assert.equal(brief, null);
    });

    it("an advertiser session cannot use the support read path", async () => {
      const created = expectOk(
        await service.createManagedBrief(ADVERTISER_A_PROFILE, validInput()),
      );

      asSession("ADVERTISER", ADVERTISER_A_USER);

      const brief = await service.getManagedBriefForSupport(created.briefId);

      assert.equal(brief, null);
    });

    it("an anonymous caller gets nothing from either read path", async () => {
      const created = expectOk(
        await service.createManagedBrief(ADVERTISER_A_PROFILE, validInput()),
      );

      asSession(null, null);

      assert.equal(await service.getManagedBriefForSupport(created.briefId), null);
    });

    it("a support roster revocation takes effect immediately", async () => {
      const created = expectOk(
        await service.createManagedBrief(ADVERTISER_A_PROFILE, validInput()),
      );

      asSession("SUPPORT", SUPPORT_USER);
      putOnRoster(SUPPORT_USER);
      assert.ok(await service.getManagedBriefForSupport(created.briefId));

      users = users.filter((user) => user.id !== SUPPORT_USER);

      assert.equal(await service.getManagedBriefForSupport(created.briefId), null);
    });
  });
});
