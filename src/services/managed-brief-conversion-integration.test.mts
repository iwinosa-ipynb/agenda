import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Cross-slice integration test — the join the unit suites cannot see.
 *
 * Chain under test (no financial objects created):
 *
 *   managed brief
 *     → SELECTED candidate (pinned to an OAuth-connected TIKTOK/X account)
 *     → DRAFT campaign via the Slice 5 conversion service
 *     → the draft satisfies getCampaignPublishBlockers
 *     → the selected creator — with exactly the pinned connected account —
 *       satisfies applyToCampaign's connected-account gate on the campaign's
 *       platform.
 *
 * The point of the join: the account the Support flow pins is the SAME shape
 * of account the marketplace application gate demands (connected TIKTOK/X),
 * so a converted campaign can never be structurally unapplyable-by its own
 * selected creator. The inverse case (claimed-only pin) is refused at
 * conversion, so no unusable campaign can ever exist from this path.
 *
 * Real modules, shared in-memory Prisma stub — only the session seams are
 * mocked. No application/agreement/obligation rows are created; the
 * application check runs against `applyToCampaign`'s guard query, which only
 * READS the campaign + social accounts.
 */

// ---------------------------------------------------------------------------
// Shared in-memory Prisma stub
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { id: string };

const db: Record<string, Row[]> = {
  socialAccount: [],
  managedBrief: [],
  managedBriefSourcingCandidate: [],
  campaign: [],
  creatorProfile: [],
  advertiserProfile: [],
  user: [],
  campaignApplication: [],
};

let nextId = 1;
const id = (prefix: string) => `${prefix}-${nextId++}`;

const UUID = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

let transactionWrites: Array<{ table: string; row: Row }> = [];

function resetDb(): void {
  for (const table of Object.keys(db)) {
    db[table] = [];
  }

  nextId = 1;
  transactionWrites = [];
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

function uniqueError(): Error {
  const error = new Error("Unique constraint failed") as Error & { code: string };

  error.code = "P2002";

  return error;
}

const prismaStub = {
  managedBrief: {
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const row = db.managedBrief.find((b) => matches(b, args.where));

      return row ? structuredClone(row) : null;
    },
  },
  managedBriefSourcingCandidate: {
    findFirst: async (args: {
      where: Record<string, unknown> & { socialAccount?: unknown };
    }) => {
      const flatWhere = { ...args.where };

      delete flatWhere.socialAccount;

      const row = db.managedBriefSourcingCandidate.find((c) =>
        matches(c, flatWhere),
      );

      if (!row) return null;

      const enriched = structuredClone(row);
      const account = db.socialAccount.find((a) => a.id === row.socialAccountId);

      if (account) {
        enriched.socialAccount = structuredClone(account);
      }

      return enriched;
    },
    update: async (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const row = db.managedBriefSourcingCandidate.find(
        (c) => c.id === args.where.id,
      );

      if (!row) {
        const error = new Error("not found") as Error & { code: string };

        error.code = "P2025";
        throw error;
      }

      if (
        args.data.campaignId !== undefined &&
        args.data.campaignId !== null &&
        typeof row.campaignId === "string" &&
        row.campaignId !== args.data.campaignId
      ) {
        throw uniqueError();
      }

      for (const [key, value] of Object.entries(args.data)) {
        (row as Record<string, unknown>)[key] = value;
      }

      transactionWrites.push({ table: "managedBriefSourcingCandidate", row });

      return structuredClone(row);
    },
  },
  campaign: {
    create: async (args: { data: Record<string, unknown> }) => {
      const row = {
        minimumFollowers: 0,
        maxCreators: 1,
        tags: [],
        startDate: null,
        endDate: null,
        applicationDeadline: null,
        contentRequirements: null,
        rules: null,
        publishedAt: null,
        targetCountry: null,
        ...args.data,
        id: id("camp"),
      } as Row;

      db.campaign.push(row);
      transactionWrites.push({ table: "campaign", row });

      return structuredClone(row);
    },
    findUnique: async (args: {
      where: { id: string };
      select?: Record<string, unknown>;
    }) => {
      const row = db.campaign.find((c) => c.id === args.where.id);

      if (!row) return null;

      const enriched = structuredClone(row) as Row & { advertiser?: unknown };

      // applyToCampaign selects the owning advertiser's user for the
      // own-campaign check.
      if ("advertiser" in (args.select ?? {})) {
        const profile = db.advertiserProfile.find(
          (e) => e.id === row.advertiserId,
        );

        enriched.advertiser = {
          user: {
            id: profile
              ? profile.userId
              : ((row as Record<string, unknown>).userId as string) ??
                row.advertiserId,
            role: "ADVERTISER",
          },
        };
      }

      return enriched;
    },
    findFirst: async (args: {
      where: Record<string, unknown>;
      select?: Record<string, unknown>;
    }) => {
      const row = db.campaign.find((c) => matches(c, args.where));

      if (!row) return null;

      const enriched = structuredClone(row) as Row & {
        _count?: unknown;
      };

      // The advertiser summary select carries the applications aggregate —
      // compute it from the stored application rows (real FK semantics).
      if ("_count" in (args.select ?? {})) {
        enriched._count = {
          applications: db.campaignApplication.filter(
            (application) => application.campaignId === row.id,
          ).length,
        };
      }

      return enriched;
    },
    updateMany: async (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      let count = 0;

      for (const row of db.campaign) {
        if (!matches(row, args.where)) continue;

        Object.assign(row, structuredClone(args.data));
        count += 1;
      }

      return { count };
    },
  },
  creatorProfile: {
    findUnique: async (args: { where: { id: string }; select?: unknown }) => {
      const row = db.creatorProfile.find((e) => e.id === args.where.id);

      if (!row) return null;

      const enriched = structuredClone(row) as Row & { user?: unknown };

      const select = (args.select ?? {}) as Record<string, unknown>;

      if ("user" in select) {
        const user = db.user.find((e) => e.id === row.userId);

        enriched.user = user ? { emailVerifiedAt: user.emailVerifiedAt } : null;
      }

      return enriched;
    },
  },
  advertiserProfile: {
    // requireViewerAdvertiserId resolves the session user's profile id — the
    // seeded row maps the mocked session user onto ADVERTISER_PROFILE_ID.
    findUnique: async (args: { where: { userId: string } }) => {
      const row = db.advertiserProfile.find(
        (e) => e.userId === args.where.userId,
      );

      return row ? structuredClone(row) : null;
    },
  },
  socialAccount: {
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const row = db.socialAccount.find((entry) => matches(entry, args.where));

      return row ? structuredClone(row) : null;
    },
  },
  campaignApplication: {
    findUnique: async () => null, // no prior application
    create: async (args: { data: Record<string, unknown> }) => {
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
  $transaction: async (input: unknown) => {
    const previousWrites = transactionWrites;

    transactionWrites = [];

    try {
      if (typeof input === "function") {
        return await (input as (tx: unknown) => Promise<unknown>)(prismaStub);
      }

      throw new TypeError("unsupported $transaction form");
    } catch (error) {
      const ownWrites = transactionWrites;

      transactionWrites = previousWrites;

      // Roll back: created campaign rows and link writes vanish.
      for (const { table, row } of ownWrites.reverse()) {
        const tableRows = db[table];
        const index = tableRows.indexOf(row);

        if (index !== -1) tableRows.splice(index, 1);
      }

      throw error;
    } finally {
      transactionWrites = [];
    }
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
mockModule("next/cache", { revalidatePath: () => undefined });

// Session seam only: the REAL advertiser.service runs (the integration test
// exercises its true getCampaignPublishBlockers), with requireRole stubbed at
// its inner @/lib/auth boundary so the session-derived identity is fixed.
mockModule("@/lib/auth", {
  auth: async () => ({
    user: {
      id: "advertiser-user-owner",
      role: "ADVERTISER",
      name: "Owner Advertiser",
      email: "owner@example.com",
    },
  }),
});

// ---------------------------------------------------------------------------
// Imports (AFTER module mocks are registered)
// ---------------------------------------------------------------------------

type ConversionService = typeof import("@/services/managed-brief-conversion.service");
type ManagedBriefActions = typeof import("@/app/dashboard/_actions/managed-brief");
type AdvertiserService = typeof import("@/services/advertiser.service");
type ApplicationService = typeof import("@/services/application.service");

let conversion: ConversionService;
let actions: ManagedBriefActions;
let advertiserService: AdvertiserService;
let applicationService: ApplicationService;

const ADVERTISER_PROFILE_ID = "adv-profile-owner";
const CREATOR_PROFILE_ID = "creator-profile-selected";
const CREATOR_USER_ID = "creator-user-selected";

function seedBrief(): Row {
  const now = new Date();
  const row: Row = {
    id: UUID(1),
    advertiserId: ADVERTISER_PROFILE_ID,
    campaignGoal: "Launch the new snack line with bold creators",
    description:
      "A full brief describing the launch, tone and deliverables in the advertiser's own words.",
    budgetMinor: 500000000n,
    currency: "NGN",
    targetAudience: "Lagos Gen Z snackers",
    targetPlatforms: ["TIKTOK"],
    creatorRequirements: "Bold on-camera energy",
    status: "IN_REVIEW",
    createdAt: now,
    updatedAt: now,
  };

  db.managedBrief.push(row);

  return row;
}

function seedSelectedCandidate(platform: string, platformUserId: string | null): {
  account: Row;
  candidate: Row;
} {
  const account: Row = {
    id: id("acct"),
    creatorId: CREATOR_PROFILE_ID,
    platform,
    username: "snackqueen",
    profileUrl: "https://example.com/snackqueen",
    platformUserId,
  };

  db.socialAccount.push(account);

  const candidate: Row = {
    // UUID-shaped: the action's schema validates candidateId as a uuid.
    id: UUID(nextId),
    briefId: UUID(1),
    creatorId: CREATOR_PROFILE_ID,
    socialAccountId: account.id,
    status: "SELECTED",
    campaignId: null,
    note: null,
    addedById: "support-1",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  db.managedBriefSourcingCandidate.push(candidate);

  return { account, candidate };
}

function seedCreatorForApplication(): void {
  db.creatorProfile.push({
    id: CREATOR_PROFILE_ID,
    userId: CREATOR_USER_ID,
  } as Row);
  db.user.push({
    id: CREATOR_USER_ID,
    emailVerifiedAt: new Date(),
  } as Row);
}

/** Map the mocked ADVERTISER session user onto the owning profile id. */
function seedAdvertiserProfile(): void {
  db.advertiserProfile.push({
    id: ADVERTISER_PROFILE_ID,
    userId: "advertiser-user-owner",
  } as Row);
}

const CONVERSION_INPUT = {
  title: "Snack line launch with creators",
  category: "FOOD" as const,
  targetLocation: "Lagos, Nigeria",
  minimumFollowers: 5000,
  maxCreators: 1,
  budget: 750000,
  contentRequirements: "Two videos",
  startDate: null,
  endDate: null,
  applicationDeadline: null,
};

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();

  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }

  return data;
}

describe("managed brief → publish → apply eligibility (integration)", () => {
  before(async () => {
    conversion = await import("@/services/managed-brief-conversion.service");
    actions = await import("@/app/dashboard/_actions/managed-brief");
    advertiserService = await import("@/services/advertiser.service");
    applicationService = await import("@/services/application.service");
  });

  beforeEach(() => {
    resetDb();
  });

  it("a connected TIKTOK selection converts, passes publish blockers, and satisfies applyToCampaign's connected-account gate", async () => {
    const brief = seedBrief();
    const { candidate } = seedSelectedCandidate("TIKTOK", "tt-owner-1");
    seedAdvertiserProfile();
    seedCreatorForApplication();

    // 1. Conversion (through the action boundary, session-derived identity).
    const converted = await actions.convertSelectedCandidateAction(
      null,
      formData({
        briefId: brief.id,
        candidateId: candidate.id,
        title: "Snack line launch with creators",
        category: "FOOD",
        targetLocation: "Lagos, Nigeria",
        minimumFollowers: "5000",
        maxCreators: "1",
        budget: "750000",
      }),
    );

    assert.equal(converted.success, true);

    const campaignId = (converted as {
      success: true;
      data: { campaignId: string };
    }).data.campaignId;

    // 2. The created draft satisfies the REAL publish blockers…
    const publishCheck = await advertiserService.getCampaignPublishBlockers(
      ADVERTISER_PROFILE_ID,
      campaignId,
    );

    assert.ok(
      !("missing" in publishCheck),
      `converted draft must have no publish blockers, got: ${
        "missing" in publishCheck ? publishCheck.missing.join(" | ") : "ok"
      }`,
    );

    // …and PUBLISHES through the real lifecycle transition.
    const published = await advertiserService.transitionCampaign(
      ADVERTISER_PROFILE_ID,
      campaignId,
      "PUBLISH",
    );

    assert.equal(published.success, true);

    // 3. The selected creator — with exactly the pinned connected account —
    //    satisfies the REAL application gate on the inherited platform.
    const apply = await applicationService.applyToCampaign(CREATOR_PROFILE_ID, {
      campaignId,
      quoteAmount: "180000", // creator-authored
      currency: "NGN",
    });

    assert.equal(apply.success, true);
    assert.equal(db.campaignApplication.length, 1);
    assert.equal(db.campaignApplication[0]?.quoteAmount, "180000.00");
    assert.equal(db.campaignApplication[0]?.status, "PENDING");
  });

  it("a claimed-only TIKTOK pin is refused at conversion with INELIGIBLE_ACCOUNT — no campaign, no link", async () => {
    const brief = seedBrief();
    const { candidate } = seedSelectedCandidate("TIKTOK", null); // legacy claimed-only pin
    seedAdvertiserProfile();
    seedCreatorForApplication();

    const converted = await actions.convertSelectedCandidateAction(
      null,
      formData({
        briefId: brief.id,
        candidateId: candidate.id,
        title: "Snack line launch with creators",
        category: "FOOD",
        targetLocation: "Lagos, Nigeria",
        minimumFollowers: "5000",
        maxCreators: "1",
        budget: "750000",
      }),
    );

    assert.equal(converted.success, false);
    assert.match(converted.error ?? "", /not connected/u);

    // Nothing was created: no campaign, no application, and the candidate's
    // link is untouched.
    assert.equal(db.campaign.length, 0);
    assert.equal(db.campaignApplication.length, 0);
    assert.equal(candidate.campaignId, null);
  });

  it("an unsupported-platform pin (INSTAGRAM) is refused at conversion even when connected", async () => {
    const brief = seedBrief();
    const { candidate } = seedSelectedCandidate("INSTAGRAM", "ig-1");
    seedAdvertiserProfile();
    seedCreatorForApplication();

    const converted = await actions.convertSelectedCandidateAction(
      null,
      formData({
        briefId: brief.id,
        candidateId: candidate.id,
        title: "Snack line launch with creators",
        category: "FOOD",
        targetLocation: "Lagos, Nigeria",
        minimumFollowers: "5000",
        maxCreators: "1",
        budget: "750000",
      }),
    );

    assert.equal(converted.success, false);
    assert.match(converted.error ?? "", /not connected/u);
    assert.equal(db.campaign.length, 0);
  });
});
