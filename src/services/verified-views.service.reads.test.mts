import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Stage 9C tests — verified-view read paths used by the dashboard UI
 * (getCampaignVerifiedViews advertiser scoping, getCreatorVerifiedViews).
 *
 * Strategy mirrors post-verification.integration.test.mts: the Prisma client
 * is replaced with an in-memory stub via node:test module mocking, so no
 * DATABASE_URL is required, and "server-only" is mocked out. No live
 * X/TikTok APIs are involved — these are pure read paths over stored rows.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma stub
// ---------------------------------------------------------------------------

type FindManyArgs = {
  where?: {
    campaignId?: string;
    campaign?: { advertiserId?: string };
    status?: string;
    creatorId?: string;
  };
};

let findManyArgs: FindManyArgs | null = null;
let findManyResult: unknown[] = [];
let countResult = 0;

const prismaStub = {
  campaignPost: {
    findMany: (args: FindManyArgs) => {
      findManyArgs = structuredClone(args);
      return Promise.resolve(structuredClone(findManyResult));
    },
    count: () => Promise.resolve(countResult),
  },
};

function mockModule(specifier: string, exports: Record<string, unknown>): void {
  (mock.module as (spec: string, opts: Record<string, unknown>) => void)(
    specifier,
    { exports },
  );
}

mockModule("server-only", {});
mockModule("@/lib/prisma", { prisma: prismaStub });

type VerifiedViewsService = typeof import("@/services/verified-views.service");

let service: VerifiedViewsService | null = null;

/** A verified post row shaped like the service's select projection. */
function verifiedPost(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    platform: "X",
    status: "VERIFIED",
    verifiedViews: 1250,
    creator: { socialAccounts: [{ platform: "X" }] },
    observations: [{ integrityStatus: "CLEAN" }],
    ...overrides,
  };
}

describe("Stage 9C — verified-view read paths for the dashboard UI", () => {
  beforeEach(() => {
    findManyArgs = null;
    findManyResult = [];
    countResult = 0;
  });

  describe("getCampaignVerifiedViews — advertiser scoping", () => {
    before(async () => {
      service = (await import(
        "@/services/verified-views.service"
      )) as VerifiedViewsService;
    });

    it("filters the query to campaigns owned by the requesting advertiser", async () => {
      findManyResult = [verifiedPost()];

      await service!.getCampaignVerifiedViews("c-1", {
        advertiserId: "adv-1",
      });

      // The ownership filter lives INSIDE the query, so rows belonging to
      // another advertiser's campaign can never be read, let alone summed.
      assert.equal(findManyArgs?.where?.campaign?.advertiserId, "adv-1");
      assert.equal(findManyArgs?.where?.campaignId, "c-1");
      assert.equal(findManyArgs?.where?.status, "VERIFIED");
    });

    it("returns zeros for an advertiser who does not own the campaign (no leak, no fake total)", async () => {
      // The stub simulates the DB honoring the advertiser filter: a foreign
      // advertiser's query matches no rows.
      findManyResult = [];

      const totals = await service!.getCampaignVerifiedViews("c-1", {
        advertiserId: "adv-attacker",
      });

      assert.equal(totals!.totalVerifiedViews, 0);
      assert.equal(totals!.eligiblePostCount, 0);
      assert.equal(totals!.verifiedPostCount, 0);
      assert.equal(totals!.hasReviewFlag, false);
    });

    it("sums only the eligible posts' current cumulative values (never a snapshot sum)", async () => {
      findManyResult = [
        verifiedPost({ id: "p1", verifiedViews: 1250 }),
        verifiedPost({ id: "p2", verifiedViews: 300 }),
        // Non-eligible shapes are excluded by the query itself; these prove
        // the aggregation layer would also refuse them if they slipped in.
        verifiedPost({ id: "p3", status: "REJECTED", verifiedViews: 9999 }),
      ];

      const totals = await service!.getCampaignVerifiedViews("c-1");

      assert.equal(totals!.totalVerifiedViews, 1550);
      assert.equal(totals!.eligiblePostCount, 2);
      assert.equal(totals!.verifiedPostCount, 2);
    });
  });

  describe("getCreatorVerifiedViews — dashboard summary", () => {
    before(async () => {
      service = (await import(
        "@/services/verified-views.service"
      )) as VerifiedViewsService;
    });

    it("scopes the query to the creator's own posts", async () => {
      findManyResult = [verifiedPost()];

      await service!.getCreatorVerifiedViews("cr-1");

      assert.equal(findManyArgs?.where?.creatorId, "cr-1");
      assert.equal(findManyArgs?.where?.status, "VERIFIED");
    });

    it("aggregates the creator's verified posts through the shared accounting layer", async () => {
      findManyResult = [
        verifiedPost({ id: "p1", verifiedViews: 1250 }),
        verifiedPost({
          id: "p2",
          verifiedViews: 400,
          observations: [{ integrityStatus: "REVIEW" }],
        }),
      ];

      const totals = await service!.getCreatorVerifiedViews("cr-1");

      assert.equal(totals.totalVerifiedViews, 1650);
      assert.equal(totals.eligiblePostCount, 2);
      assert.equal(totals.verifiedPostCount, 2);
      assert.equal(totals.hasReviewFlag, true);
    });

    it("returns honest zeros when the creator has no verified content (no fabricated metrics)", async () => {
      findManyResult = [];

      const totals = await service!.getCreatorVerifiedViews("cr-empty");

      assert.equal(totals.totalVerifiedViews, 0);
      assert.equal(totals.eligiblePostCount, 0);
      assert.equal(totals.verifiedPostCount, 0);
      assert.equal(totals.hasReviewFlag, false);
    });
  });
});
