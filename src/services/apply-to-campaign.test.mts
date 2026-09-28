import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Dedicated suite for the marketplace application gate (Stage 12).
 *
 * `applyToCampaign` is authoritative and is NOT modified by the managed-brief
 * eligibility work — this suite pins its existing critical rules so the
 * managed-brief boundary can be verified against them:
 *
 *   - verified Agenda email (DB-checked, not session-claimed);
 *   - campaign must be PUBLISHED (drafts invisible, statuses server-owned);
 *   - application deadline still open;
 *   - quote currency must match the campaign currency;
 *   - a CONNECTED (OAuth-proven) account on the campaign's platform is
 *     required — `platformUserId: { not: null }`; a claimed-only account
 *     cannot enter the marketplace;
 *   - a creator cannot apply to their own advertiser campaign;
 *   - one application per campaign+creator (DB unique constraint arbiter);
 *   - the quote is CREATOR-authored: whatever the client sends is the quote —
 *     nothing is ever derived from rate cards, budgets or CPM values.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma stub
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { id: string };

const db: Record<string, Row[]> = {
  creatorProfile: [],
  user: [],
  campaign: [],
  socialAccount: [],
  campaignApplication: [],
};

let nextId = 1;
const id = (prefix: string) => `${prefix}-${nextId++}`;

// Sequence of values returned by the application unique-find (simulating the
// DB's unique lookup); each call shifts one value off.
let existingApplicationQueue: (Row | null)[] = [];
// When set, campaignApplication.create rejects with a Prisma-shaped P2002
// (the DB unique-constraint race path).
let failApplicationCreateWithP2002 = false;

function resetDb(): void {
  for (const table of Object.keys(db)) {
    db[table] = [];
  }

  nextId = 1;
  existingApplicationQueue = [];
  failApplicationCreateWithP2002 = false;
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (condition === null) {
      if (row[key] !== null) return false;
      continue;
    }

    if (condition === undefined) continue;

    if (typeof condition === "object" && !Array.isArray(condition)) {
      const operators = condition as Record<string, unknown>;

      if ("not" in operators && row[key] === operators.not) return false;
      if ("in" in operators && !(operators.in as unknown[]).includes(row[key])) {
        return false;
      }

      continue;
    }

    if (row[key] !== condition) return false;
  }

  return true;
}

const prismaStub: Record<string, unknown> = {
  creatorProfile: {
    findUnique: async (args: { where: { id: string }; select?: unknown }) => {
      const row = db.creatorProfile.find((entry) => entry.id === args.where.id);

      if (!row) return null;

      const enriched = structuredClone(row) as Row & {
        user?: unknown;
      };

      const select = (args.select ?? {}) as Record<string, unknown>;

      if ("user" in select) {
        const user = db.user.find((entry) => entry.id === row.userId);

        enriched.user = user ? { emailVerifiedAt: user.emailVerifiedAt } : null;
      }

      return enriched;
    },
  },
  campaign: {
    findUnique: async (args: { where: { id: string }; select?: unknown }) => {
      const row = db.campaign.find((entry) => entry.id === args.where.id);

      if (!row) return null;

      const enriched = structuredClone(row) as Row & { advertiser?: unknown };

      const select = (args.select ?? {}) as Record<string, unknown>;

      if ("advertiser" in select) {
        // Campaign → AdvertiserProfile → User: the owning advertiser's USER
        // id is what the own-campaign check compares against. Seeded campaign
        // rows carry it as `userId` (the stub's stand-in for the relation).
        enriched.advertiser = {
          user: { id: (row.userId as string) ?? row.advertiserId, role: "ADVERTISER" },
        };
      }

      return enriched;
    },
  },
  socialAccount: {
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const row = db.socialAccount.find((entry) => matches(entry, args.where));

      return row ? structuredClone(row) : null;
    },
  },
  campaignApplication: {
    findUnique: async () => {
      if (existingApplicationQueue.length > 0) {
        const next = existingApplicationQueue.shift();

        return next ? structuredClone(next) : null;
      }

      return null;
    },
    create: async (args: { data: Record<string, unknown> }) => {
      if (failApplicationCreateWithP2002) {
        const error = new Error("dup") as Error & { code: string };

        error.code = "P2002";
        throw error;
      }

      const row = {
        ...args.data,
        id: id("app"),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Row;

      db.campaignApplication.push(row);

      return structuredClone(row);
    },
  },
} as unknown as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Module mocks — registered BEFORE anything under test is imported
// ---------------------------------------------------------------------------

function mockModule(specifier: string, exports: Record<string, unknown>): void {
  (mock.module as (spec: string, opts: Record<string, unknown>) => void)(
    specifier,
    { exports },
  );
}

mockModule("server-only", {});
mockModule("@/lib/prisma", { prisma: prismaStub as never });

// ---------------------------------------------------------------------------
// Imports (AFTER module mocks are registered)
// ---------------------------------------------------------------------------

type ApplicationService = typeof import("@/services/application.service");

let applicationService: ApplicationService;

const UUID = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const CREATOR_ID = "creator-profile-1";
const ADVERTISER_USER_ID = "advertiser-user-1";
const OTHER_ADVERTISER_USER_ID = "advertiser-user-2";

function seedVerifiedCreator(userId: string): Row {
  const row: Row = {
    id: CREATOR_ID,
    userId,
  };

  db.creatorProfile.push(row);
  db.user.push({ id: userId, emailVerifiedAt: new Date() } as Row);

  return row;
}

function seedUnverifiedCreator(userId: string): Row {
  const row: Row = {
    id: CREATOR_ID,
    userId,
  };

  db.creatorProfile.push(row);
  db.user.push({ id: userId, emailVerifiedAt: null } as Row);

  return row;
}

function seedPublishedCampaign(overrides: Record<string, unknown> = {}): Row {
  const row: Row = {
    id: UUID(1),
    status: "PUBLISHED",
    applicationDeadline: new Date(Date.now() + 86_400_000), // tomorrow
    currency: "NGN",
    platform: "TIKTOK",
    advertiserId: "adv-profile-1",
    userId: OTHER_ADVERTISER_USER_ID, // what the stub's advertiser include resolves to
    ...overrides,
  };

  db.campaign.push(row);

  return row;
}

function seedConnectedAccount(
  platform: string,
  platformUserId: string | null = `platform-${CREATOR_ID}`,
): Row {
  const row: Row = {
    id: id("acct"),
    creatorId: CREATOR_ID,
    platform,
    platformUserId,
  };

  db.socialAccount.push(row);

  return row;
}

const VALID_INPUT = {
  campaignId: UUID(1),
  quoteAmount: "150000",
  currency: "NGN",
  message: "Excited to work on this.",
};

describe("applyToCampaign — marketplace application gate", () => {
  before(async () => {
    applicationService = await import("@/services/application.service");
  });

  beforeEach(() => {
    resetDb();
    seedVerifiedCreator("creator-user-1");
  });

  it("creates a PENDING application with the CREATOR-authored quote", async () => {
    seedPublishedCampaign();
    seedConnectedAccount("TIKTOK");

    const result = await applicationService.applyToCampaign(CREATOR_ID, VALID_INPUT);

    assert.equal(result.success, true);

    const stored = db.campaignApplication[0];

    assert.equal(stored?.status, "PENDING");
    // The creator's own number — never a rate card, budget or CPM value.
    assert.equal(stored?.quoteAmount, "150000.00");
    assert.equal(stored?.currency, "NGN");
    assert.equal(stored?.creatorId, CREATOR_ID);
  });

  it("refuses an unverified email (DB-checked, not session-claimed)", async () => {
    resetDb();
    seedUnverifiedCreator("creator-user-1");
    seedPublishedCampaign();
    seedConnectedAccount("TIKTOK");

    const result = await applicationService.applyToCampaign(CREATOR_ID, VALID_INPUT);

    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.error, /Verify your email/u);
    }
    assert.equal(db.campaignApplication.length, 0);
  });

  it("refuses a DRAFT campaign — creators cannot see or apply to drafts", async () => {
    seedPublishedCampaign({ status: "DRAFT" });
    seedConnectedAccount("TIKTOK");

    const result = await applicationService.applyToCampaign(CREATOR_ID, VALID_INPUT);

    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.error, /isn't accepting applications/u);
    }
    assert.equal(db.campaignApplication.length, 0);
  });

  it("refuses a campaign whose application deadline has passed", async () => {
    seedPublishedCampaign({
      applicationDeadline: new Date(Date.now() - 3_600_000), // an hour ago
    });
    seedConnectedAccount("TIKTOK");

    const result = await applicationService.applyToCampaign(CREATOR_ID, VALID_INPUT);

    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.error, /have closed/u);
    }
    assert.equal(db.campaignApplication.length, 0);
  });

  it("refuses a quote in a currency that does not match the campaign", async () => {
    seedPublishedCampaign();
    seedConnectedAccount("TIKTOK");

    const result = await applicationService.applyToCampaign(CREATOR_ID, {
      ...VALID_INPUT,
      currency: "USD",
    });

    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.error, /Quote in NGN/u);
    }
    assert.equal(db.campaignApplication.length, 0);
  });

  it("refuses a creator with NO account on the campaign platform", async () => {
    seedPublishedCampaign();
    // A connected X account exists — but the campaign is on TIKTOK.
    seedConnectedAccount("X");

    const result = await applicationService.applyToCampaign(CREATOR_ID, VALID_INPUT);

    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.error, /Connect your TIKTOK account/u);
    }
    assert.equal(db.campaignApplication.length, 0);
  });

  it("refuses a CLAIMED-ONLY account on the campaign platform (platformUserId null)", async () => {
    seedPublishedCampaign();
    seedConnectedAccount("TIKTOK", null); // claimed, never OAuth-connected

    const result = await applicationService.applyToCampaign(CREATOR_ID, VALID_INPUT);

    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.error, /Connect your TIKTOK account/u);
    }
    assert.equal(db.campaignApplication.length, 0);
  });

  it("accepts the platform's account even when another platform's account is claimed-only", async () => {
    seedPublishedCampaign();
    seedConnectedAccount("X", null); // irrelevant to this campaign
    seedConnectedAccount("TIKTOK"); // connected on the campaign platform

    const result = await applicationService.applyToCampaign(CREATOR_ID, VALID_INPUT);

    assert.equal(result.success, true);
  });

  it("refuses a creator applying to their own advertiser campaign", async () => {
    // The creator's user record doubles as the campaign-owning advertiser's
    // user (same person, two roles) — the real service compares the campaign's
    // advertiser user id with the applying creator profile's userId.
    db.user.push({ id: ADVERTISER_USER_ID, emailVerifiedAt: new Date() } as Row);
    seedPublishedCampaign({ userId: ADVERTISER_USER_ID });
    db.creatorProfile[0]!.userId = ADVERTISER_USER_ID;
    seedConnectedAccount("TIKTOK");

    const result = await applicationService.applyToCampaign(CREATOR_ID, VALID_INPUT);

    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.error, /own campaign/u);
    }
    assert.equal(db.campaignApplication.length, 0);
  });

  it("refuses a duplicate active application (pre-check path)", async () => {
    seedPublishedCampaign();
    seedConnectedAccount("TIKTOK");

    existingApplicationQueue = [
      { id: "app-existing", status: "PENDING" } as Row,
    ];

    const result = await applicationService.applyToCampaign(CREATOR_ID, VALID_INPUT);

    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.error, /already applied/u);
    }
    assert.equal(db.campaignApplication.length, 0);
  });

  it("allows re-application after WITHDRAWN (the freed slot)", async () => {
    seedPublishedCampaign();
    seedConnectedAccount("TIKTOK");

    existingApplicationQueue = [
      { id: "app-withdrawn", status: "WITHDRAWN" } as Row,
    ];

    const result = await applicationService.applyToCampaign(CREATOR_ID, VALID_INPUT);

    assert.equal(result.success, true);
    assert.equal(db.campaignApplication.length, 1);
  });

  it("the DB unique constraint is the arbiter when the pre-check races (P2002)", async () => {
    seedPublishedCampaign();
    seedConnectedAccount("TIKTOK");

    failApplicationCreateWithP2002 = true;

    const result = await applicationService.applyToCampaign(CREATOR_ID, VALID_INPUT);

    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.error, /already applied/u);
    }
    assert.equal(db.campaignApplication.length, 0);
  });

  it("refuses a nonexistent campaign", async () => {
    seedConnectedAccount("TIKTOK");

    const result = await applicationService.applyToCampaign(CREATOR_ID, VALID_INPUT);

    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.error, /no longer exists/u);
    }
    assert.equal(db.campaignApplication.length, 0);
  });
});
