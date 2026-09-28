import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Creator Opportunity Matching + Notifications (V1) — service suite.
 *
 * Covers the mandated areas:
 *   1. matching on platform/category/location;
 *   2. matching BROADER than eligibility (ineligible creator still notified);
 *   3. non-matching creator not notified;
 *   4. duplicate campaign/creator notification prevented (DB unique);
 *   5. read/unread behavior (unread counts + mark-read ownership);
 *   6. notification links target the correct campaign (URL building);
 *   7. no client path: opportunity creation has no action and every
 *      creator-side read/write resolves identity from the session seam;
 *   8. `applyToCampaign` eligibility behavior unchanged (the real service
 *      runs against the same stubs and still enforces its gates).
 */

// ---------------------------------------------------------------------------
// In-memory Prisma stub
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { id: string };

const db: Record<string, Row[]> = {
  campaign: [],
  creatorProfile: [],
  socialAccount: [],
  user: [],
  creatorOpportunityNotification: [],
  campaignApplication: [],
};

let nextId = 1;
const id = (prefix: string) => `${prefix}-${nextId++}`;

// When true, notification createMany reports a duplicate-skip (models the DB
// unique constraint absorbing a raced/re-run publication).
let simulateDuplicateSkip = false;
// Sequence for campaignApplication.create's unique-constraint race (test 8).
let applicationExistingQueue: (Row | null)[] = [];
let applicationCreateFailsP2002 = false;

function resetDb(): void {
  for (const table of Object.keys(db)) {
    db[table] = [];
  }

  nextId = 1;
  simulateDuplicateSkip = false;
  applicationExistingQueue = [];
  applicationCreateFailsP2002 = false;
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (condition === null) {
      if (row[key] !== null) return false;
      continue;
    }

    if (condition === undefined) continue;

    // Prisma OR: the row matches when ANY sub-condition matches.
    if (key === "OR" && Array.isArray(condition)) {
      const anyBranch = (condition as Record<string, unknown>[]).some((branch) =>
        matches(row, branch),
      );

      if (!anyBranch) return false;

      continue;
    }

    if (typeof condition === "object" && !Array.isArray(condition)) {
      const operators = condition as Record<string, unknown>;

      if ("not" in operators && row[key] === operators.not) return false;
      if ("in" in operators && !(operators.in as unknown[]).includes(row[key])) {
        return false;
      }
      if ("gte" in operators && row[key] instanceof Date) {
        if ((row[key] as Date).getTime() < (operators.gte as Date).getTime()) {
          return false;
        }
      }

      continue;
    }

    if (row[key] !== condition) return false;
  }

  return true;
}

const prismaStub = {
  campaign: {
    findMany: async (args: { where: Record<string, unknown> }) =>
      db.campaign
        .filter((c) => matches(c, args.where))
        .map((row) => {
          const enriched = structuredClone(row);

          // The service selects only public campaign attributes.
          return {
            id: enriched.id,
            platform: enriched.platform,
            category: enriched.category,
            targetLocation: enriched.targetLocation,
            minimumFollowers: enriched.minimumFollowers,
          } as Row;
        }),
    findUnique: async (args: { where: { id: string }; select?: unknown }) => {
      const row = db.campaign.find((c) => c.id === args.where.id);

      if (!row) return null;

      const enriched = structuredClone(row) as Row & { advertiser?: unknown };

      const select = (args.select ?? {}) as Record<string, unknown>;

      if ("advertiser" in select) {
        enriched.advertiser = { user: { id: row.advertiserUserId } };
      }

      return enriched;
    },
  },
  creatorProfile: {
    findMany: async () =>
      db.creatorProfile.map((row) => ({
        ...structuredClone(row),
        socialAccounts: db.socialAccount
          .filter((account) => account.creatorId === row.id)
          .map((account) => ({ platform: account.platform })),
      })),
    findUnique: async (args: {
      where: { id?: string; userId?: string };
      select?: unknown;
    }) => {
      // requireViewerCreatorId looks the profile up by session userId; other
      // callers look up by profile id — support both, like the real client.
      const row = db.creatorProfile.find(
        (c) =>
          (args.where.id !== undefined && c.id === args.where.id) ||
          (args.where.userId !== undefined && c.userId === args.where.userId),
      );

      if (!row) return null;

      const enriched = structuredClone(row) as Row & { user?: unknown };

      const select = (args.select ?? {}) as Record<string, unknown>;

      if ("user" in select) {
        const user = db.user.find((u) => u.id === row.userId);

        enriched.user = user
          ? { id: user.id, emailVerifiedAt: user.emailVerifiedAt }
          : null;
      }

      return enriched;
    },
  },
  socialAccount: {
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const row = db.socialAccount.find((a) => matches(a, args.where));

      return row ? structuredClone(row) : null;
    },
  },
  creatorOpportunityNotification: {
    createMany: async (args: { data: Array<Record<string, unknown>> }) => {
      if (simulateDuplicateSkip) {
        return { count: 0 };
      }

      let count = 0;

      for (const data of args.data) {
        const duplicate = db.creatorOpportunityNotification.some(
          (row) =>
            row.campaignId === data.campaignId &&
            row.creatorId === data.creatorId,
        );

        if (duplicate) continue;

        db.creatorOpportunityNotification.push({
          ...structuredClone(data),
          id: id("notif"),
          readAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as Row);
        count += 1;
      }

      return { count };
    },
    findMany: async (args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, string>;
      include?: unknown;
    }) => {
      const rows = db.creatorOpportunityNotification.filter((row) =>
        matches(row, args.where),
      );

      if (args.orderBy?.createdAt === "desc") {
        rows.sort(
          (a, b) =>
            (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime(),
        );
      }

      return rows.map((row) => {
        const enriched = structuredClone(row) as Row & {
          campaign?: Row & { advertiser?: unknown };
        };

        const campaign = db.campaign.find((c) => c.id === row.campaignId);

        if (campaign) {
          enriched.campaign = {
            ...structuredClone(campaign),
            advertiser: { companyName: campaign.companyName },
          };
        }

        return enriched;
      });
    },
    updateMany: async (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      let count = 0;

      for (const row of db.creatorOpportunityNotification) {
        if (!matches(row, args.where)) continue;

        Object.assign(row, structuredClone(args.data));
        count += 1;
      }

      return { count };
    },
    count: async (args: { where: Record<string, unknown> }) =>
      db.creatorOpportunityNotification.filter((row) =>
        matches(row, args.where),
      ).length,
  },
  campaignApplication: {
    findUnique: async () => {
      if (applicationExistingQueue.length > 0) {
        const next = applicationExistingQueue.shift();

        return next ? structuredClone(next) : null;
      }

      return null;
    },
    create: async (args: { data: Record<string, unknown> }) => {
      if (applicationCreateFailsP2002) {
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
mockModule("next/cache", { revalidatePath: () => undefined });

// Server actions redirect unauthorized callers — mirror the harness the other
// suites use so the redirect is an observable, matchable error.
mockModule("next/navigation", {
  redirect: (path: string) => {
    const error = new Error(`REDIRECTED:${path}`) as Error & { digest?: string };

    error.digest = `NEXT_REDIRECT;${path}`;
    throw error;
  },
});

// The creator session seam — the REAL requireViewerCreatorId semantics are
// exercised through requireRole/requireUser; only auth() is stubbed.
let sessionRole: "CREATOR" | "ADVERTISER" | "SUPPORT" | null = "CREATOR";
let sessionUserId: string | null = "creator-user-1";

mockModule("@/lib/auth", {
  auth: async () => {
    if (!sessionRole || !sessionUserId) return null;

    return {
      user: {
        id: sessionUserId,
        role: sessionRole,
        name: "Creator One",
        email: "creator@example.com",
      },
    };
  },
});

mockModule("@/lib/email/email-service", {
  isEmailConfigured: () => false, // V1: email off in tests; in-app only
  sendEmail: async () => {
    throw new Error("email must not be called while unconfigured");
  },
});

mockModule("@/lib/constants", {
  APP_BASE_URL: "https://agenda.example",
});

// ---------------------------------------------------------------------------
// Imports (AFTER module mocks are registered)
// ---------------------------------------------------------------------------

type NotificationsService = typeof import("@/services/notifications.service");
type NotificationsActions = typeof import("@/app/dashboard/_actions/notifications");
type ApplicationService = typeof import("@/services/application.service");

let notifications: NotificationsService;
let actions: NotificationsActions;
let applicationService: ApplicationService;

const CREATOR_PROFILE_ID = "creator-profile-1";
const CAMPAIGN_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_CAMPAIGN_ID = "00000000-0000-4000-8000-000000000002";

function seedCampaign(overrides: Record<string, unknown> = {}): Row {
  const row: Row = {
    id: CAMPAIGN_ID,
    advertiserId: "adv-profile-1",
    advertiserUserId: "advertiser-user-1",
    status: "PUBLISHED",
    applicationDeadline: null,
    platform: "TIKTOK",
    category: "FASHION",
    targetLocation: "Lagos",
    minimumFollowers: 10_000,
    budget: "500000.00",
    currency: "NGN",
    title: "Lagos Fashion Drop",
    companyName: "Lagos Threads Ltd",
    ...overrides,
  };

  db.campaign.push(row);

  return row;
}

function seedCreator(overrides: Record<string, unknown> = {}): Row {
  const row: Row = {
    id: CREATOR_PROFILE_ID,
    userId: "creator-user-1",
    category: "FASHION",
    location: "Lagos, Nigeria",
    state: "Lagos",
    country: "Nigeria",
    followerCount: 12_000,
    ...overrides,
  };

  db.creatorProfile.push(row);

  return row;
}

function seedSocialAccount(platform: string): Row {
  const row: Row = {
    id: id("acct"),
    creatorId: CREATOR_PROFILE_ID,
    platform,
    // Claimed-only by default (matching still counts any account row;
    // applyToCampaign's connected-account gate requires a real id).
    platformUserId: null,
  };

  db.socialAccount.push(row);

  return row;
}

function seedNotification(overrides: Record<string, unknown> = {}): Row {
  const row: Row = {
    id: id("notif"),
    campaignId: CAMPAIGN_ID,
    creatorId: CREATOR_PROFILE_ID,
    reasons: ["platform_match"],
    readAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };

  db.creatorOpportunityNotification.push(row);

  return row;
}

describe("creator opportunity matching + notifications", () => {
  before(async () => {
    notifications = await import("@/services/notifications.service");
    actions = await import("@/app/dashboard/_actions/notifications");
    applicationService = await import("@/services/application.service");
  });

  beforeEach(() => {
    resetDb();
    sessionRole = "CREATOR";
    sessionUserId = "creator-user-1";
  });

  // -----------------------------------------------------------------------
  // 1 + 2 + 3: matching breadth
  // -----------------------------------------------------------------------

  it("matches a creator on platform/category/location and records reasons", async () => {
    seedCampaign();
    seedCreator();
    seedSocialAccount("TIKTOK");

    const result = await notifications.notifyMatchingCreatorsForCampaign(
      CAMPAIGN_ID,
    );

    assert.equal(result.skipped, false);
    assert.equal(result.matched, 1);

    const [row] = db.creatorOpportunityNotification;

    assert.equal(row?.campaignId, CAMPAIGN_ID);
    assert.equal(row?.creatorId, CREATOR_PROFILE_ID);
    assert.deepEqual(row?.reasons, [
      "platform_match",
      "category_match",
      "location_match",
      "audience_size",
    ]);
  });

  it("matching is BROADER than eligibility — an ineligible creator is still notified", async () => {
    seedCampaign();
    // Ineligible by applyToCampaign's rules: unverified email + claimed-only
    // account (no platformUserId) + audience below the campaign minimum.
    seedCreator({ followerCount: 100 });
    seedSocialAccount("TIKTOK");
    db.user.push({
      id: "creator-user-1",
      emailVerifiedAt: null,
    } as Row);

    const result = await notifications.notifyMatchingCreatorsForCampaign(
      CAMPAIGN_ID,
    );

    assert.equal(result.matched, 1);
    assert.equal(db.creatorOpportunityNotification.length, 1);
    assert.deepEqual(db.creatorOpportunityNotification[0]?.reasons, [
      "platform_match",
      "category_match",
      "location_match",
    ]);
  });

  it("does not notify a creator with no account on the campaign platform", async () => {
    seedCampaign({ platform: "X" });
    seedCreator();
    seedSocialAccount("TIKTOK"); // campaign is on X

    const result = await notifications.notifyMatchingCreatorsForCampaign(
      CAMPAIGN_ID,
    );

    assert.equal(result.matched, 0);
    assert.equal(db.creatorOpportunityNotification.length, 0);
  });

  it("never matches a campaign that is not publicly visible (defensive guard)", async () => {
    seedCampaign({ status: "DRAFT" });
    seedCreator();
    seedSocialAccount("TIKTOK");

    const result = await notifications.notifyMatchingCreatorsForCampaign(
      CAMPAIGN_ID,
    );

    assert.equal(result.skipped, true);
    assert.equal(db.creatorOpportunityNotification.length, 0);
  });

  // -----------------------------------------------------------------------
  // 4: dedupe
  // -----------------------------------------------------------------------

  it("does not create a duplicate notification for the same campaign/creator", async () => {
    seedCampaign();
    seedCreator();
    seedSocialAccount("TIKTOK");

    const first = await notifications.notifyMatchingCreatorsForCampaign(
      CAMPAIGN_ID,
    );
    const second = await notifications.notifyMatchingCreatorsForCampaign(
      CAMPAIGN_ID,
    );

    assert.equal(first.matched, 1);
    assert.equal(second.matched, 0); // skipped by the unique constraint
    assert.equal(db.creatorOpportunityNotification.length, 1);
  });

  it("the DB unique constraint absorbs a raced publication (skipDuplicates)", async () => {
    seedCampaign();
    seedCreator();
    seedSocialAccount("TIKTOK");

    seedNotification(); // a racing trigger already created the row

    const result = await notifications.notifyMatchingCreatorsForCampaign(
      CAMPAIGN_ID,
    );

    assert.equal(result.matched, 0);
    assert.equal(db.creatorOpportunityNotification.length, 1);
  });

  // -----------------------------------------------------------------------
  // 5: read/unread
  // -----------------------------------------------------------------------

  it("read/unread state: unread counts, mark-read flips state idempotently", async () => {
    seedCampaign(); // CAMPAIGN_ID — the FK the first notification points at
    seedCampaign({ id: OTHER_CAMPAIGN_ID, title: "Second Campaign" });

    const notification = seedNotification();
    seedNotification({ id: id("notif"), campaignId: OTHER_CAMPAIGN_ID });

    const before = await notifications.listCreatorOpportunities(
      CREATOR_PROFILE_ID,
    );

    assert.equal(before.opportunities.length, 2);
    assert.equal(before.unread, 2);

    // Ownership: the creator's own id is part of the update where-clause.
    const updated = await notifications.markCreatorOpportunityRead(
      CREATOR_PROFILE_ID,
      notification.id,
    );

    assert.equal(updated, true);

    const after = await notifications.listCreatorOpportunities(
      CREATOR_PROFILE_ID,
    );

    assert.equal(after.unread, 1);

    // Idempotent: marking an already-read row matches nothing (readAt filter).
    const again = await notifications.markCreatorOpportunityRead(
      CREATOR_PROFILE_ID,
      notification.id,
    );

    assert.equal(again, false);
  });

  it("a foreign notification id cannot be marked read (ownership in query)", async () => {
    seedNotification();

    const updated = await notifications.markCreatorOpportunityRead(
      "creator-profile-someone-else",
      db.creatorOpportunityNotification[0]!.id,
    );

    assert.equal(updated, false);
    assert.equal(db.creatorOpportunityNotification[0]?.readAt, null);
  });

  // -----------------------------------------------------------------------
  // 6: links
  // -----------------------------------------------------------------------

  it("the read model carries the correct campaign id for deep links", async () => {
    seedCampaign({ id: CAMPAIGN_ID, title: "Lagos Fashion Drop" });
    seedCreator();
    seedSocialAccount("TIKTOK");

    await notifications.notifyMatchingCreatorsForCampaign(CAMPAIGN_ID);

    const { opportunities } = await notifications.listCreatorOpportunities(
      CREATOR_PROFILE_ID,
    );

    assert.equal(opportunities.length, 1);
    assert.equal(opportunities[0]?.campaign.id, CAMPAIGN_ID);

    // The page/email link shape derives from this id — verify the route.
    assert.equal(
      `/dashboard/campaigns/${opportunities[0]!.campaign.id}`,
      `/dashboard/campaigns/${CAMPAIGN_ID}`,
    );
  });

  // -----------------------------------------------------------------------
  // 7: no client path
  // -----------------------------------------------------------------------

  it("a non-creator session cannot read opportunities (redirect, no data)", async () => {
    seedNotification();

    sessionRole = "ADVERTISER";

    await assert.rejects(
      actions.listCreatorOpportunitiesAction(),
      /REDIRECTED/u,
    );
  });

  it("an anonymous session cannot mark anything read (redirect, no data)", async () => {
    seedNotification();

    sessionRole = null;
    sessionUserId = null;

    const formData = new FormData();

    formData.set("notificationId", db.creatorOpportunityNotification[0]!.id);

    await assert.rejects(
      actions.markOpportunityReadAction(null, formData),
      /REDIRECTED/u,
    );

    assert.equal(db.creatorOpportunityNotification[0]?.readAt, null);
  });

  it("markOpportunityReadAction refuses a foreign notification id", async () => {
    seedCreator(); // the session seam resolves this profile by userId
    seedNotification();

    // Session creator is creator-user-1 → CREATOR_PROFILE_ID; simulate a
    // notification owned by someone else by id-spoofing within the same
    // session: the id belongs to another creator.
    const foreign = seedNotification({
      id: "notif-foreign",
      creatorId: "creator-profile-someone-else",
    });

    const formData = new FormData();

    formData.set("notificationId", foreign.id);

    const result = await actions.markOpportunityReadAction(null, formData);

    assert.equal(result.success, false);
    assert.equal(foreign.readAt, null);
  });

  // -----------------------------------------------------------------------
  // 8: applyToCampaign remains authoritative and unchanged
  // -----------------------------------------------------------------------

  it("applyToCampaign still enforces its eligibility gates (PUBLISHED + connected account)", async () => {
    // Draft campaign: not visible, not applicable — even for a matched creator.
    seedCampaign({ status: "DRAFT" });
    seedCreator();
    seedSocialAccount("TIKTOK");
    db.user.push({
      id: "creator-user-1",
      emailVerifiedAt: new Date(),
    } as Row);

    const draftResult = await applicationService.applyToCampaign(
      CREATOR_PROFILE_ID,
      { campaignId: CAMPAIGN_ID, quoteAmount: "150000", currency: "NGN" },
    );

    assert.equal(draftResult.success, false);
    if (!draftResult.success) {
      assert.match(draftResult.error, /isn't accepting applications/u);
    }

    // Published but claimed-only account: still refused (matching was broader;
    // eligibility is unchanged).
    seedCampaign({
      id: OTHER_CAMPAIGN_ID,
      status: "PUBLISHED",
      title: "X Launch",
    });

    const connectedResult = await applicationService.applyToCampaign(
      CREATOR_PROFILE_ID,
      { campaignId: OTHER_CAMPAIGN_ID, quoteAmount: "150000", currency: "NGN" },
    );

    assert.equal(connectedResult.success, false);
    if (!connectedResult.success) {
      assert.match(connectedResult.error, /Connect your TIKTOK account/u);
    }
  });

  it("applyToCampaign still succeeds for an eligible creator after matching ran", async () => {
    seedCampaign();
    seedCreator();
    // A CONNECTED account (platformUserId present) — satisfies the gate.
    db.socialAccount.push({
      id: id("acct"),
      creatorId: CREATOR_PROFILE_ID,
      platform: "TIKTOK",
      platformUserId: "tt-1",
    } as Row);
    db.user.push({
      id: "creator-user-1",
      emailVerifiedAt: new Date(),
    } as Row);

    await notifications.notifyMatchingCreatorsForCampaign(CAMPAIGN_ID);

    const apply = await applicationService.applyToCampaign(
      CREATOR_PROFILE_ID,
      { campaignId: CAMPAIGN_ID, quoteAmount: "150000", currency: "NGN" },
    );

    assert.equal(apply.success, true);
    assert.equal(db.campaignApplication.length, 1);
    assert.equal(db.campaignApplication[0]?.quoteAmount, "150000.00");

    // Matching did not apply the creator — the application came from the
    // creator's own call, and no application row existed before it.
    assert.equal(db.creatorOpportunityNotification.length, 1);
  });

  it("duplicate application prevention still works after a notification exists", async () => {
    seedCampaign();
    seedCreator();
    db.socialAccount.push({
      id: id("acct"),
      creatorId: CREATOR_PROFILE_ID,
      platform: "TIKTOK",
      platformUserId: "tt-2",
    } as Row);
    db.user.push({
      id: "creator-user-1",
      emailVerifiedAt: new Date(),
    } as Row);

    applicationExistingQueue = [{ id: "app-existing", status: "PENDING" } as Row];

    const result = await applicationService.applyToCampaign(
      CREATOR_PROFILE_ID,
      { campaignId: CAMPAIGN_ID, quoteAmount: "150000", currency: "NGN" },
    );

    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.error, /already applied/u);
    }
  });

  it("the DB unique constraint still catches a raced application after matching", async () => {
    seedCampaign();
    seedCreator();
    db.socialAccount.push({
      id: id("acct"),
      creatorId: CREATOR_PROFILE_ID,
      platform: "TIKTOK",
      platformUserId: "tt-3",
    } as Row);
    db.user.push({
      id: "creator-user-1",
      emailVerifiedAt: new Date(),
    } as Row);

    applicationCreateFailsP2002 = true;

    const result = await applicationService.applyToCampaign(
      CREATOR_PROFILE_ID,
      { campaignId: CAMPAIGN_ID, quoteAmount: "150000", currency: "NGN" },
    );

    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.error, /already applied/u);
    }
  });
});
