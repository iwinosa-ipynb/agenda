import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Stage 12 pricing invariants (brief §10 / §18 / §6).
 *
 * Pins the pricing model's critical properties at the service layer, using
 * in-memory Prisma stubs (no DATABASE_URL), mirroring the project's other
 * integration tests:
 *
 *   1. An accepted application's quote is immutable — rate-card changes never
 *      touch it (§10, §18).
 *   2. The agreement's frozen terms are never rewritten by rate-card edits.
 *   3. Pricing guidance returns INSUFFICIENT_DATA when there is no real
 *      accepted-agreement history — no fabricated ranges.
 *   4. Advertiser acceptance always freezes the CREATOR's quote — the
 *      advertiser has no write path to the quote at all.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma stub
// ---------------------------------------------------------------------------

type ApplicationRow = {
  id: string;
  campaignId: string;
  creatorId: string;
  status: "PENDING" | "ACCEPTED" | "REJECTED" | "WITHDRAWN";
  message: string | null;
  quoteAmount: string;
  currency: string;
};

type AgreementRow = {
  id: string;
  campaignId: string;
  applicationId: string;
  advertiserId: string;
  creatorId: string;
  status: "ACTIVE" | "COMPLETED" | "CANCELLED";
  platform: string;
  agreedAmount: string;
  currency: string;
};

type RateCardRow = {
  id: string;
  creatorId: string;
  platform: string;
  serviceType: string;
  price: string;
  currency: string;
  status: "ACTIVE" | "INACTIVE";
  version: number;
};

type CampaignRow = {
  id: string;
  advertiserId: string;
  status: string;
  platform: string;
  category: string;
  currency: string;
  budget: string;
  maxCreators: number;
};

let applications: ApplicationRow[] = [];
let agreements: AgreementRow[] = [];
let rateCardItems: RateCardRow[] = [];
let campaigns: CampaignRow[] = [];
let nextId = 1;

function resetDb() {
  applications = [];
  agreements = [];
  rateCardItems = [];
  campaigns = [];
  nextId = 1;
}

function addCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  const row: CampaignRow = {
    id: `camp-${nextId++}`,
    advertiserId: "adv-1",
    status: "PUBLISHED",
    platform: "TIKTOK",
    category: "FASHION",
    currency: "NGN",
    budget: "500000.00",
    maxCreators: 5,
    ...overrides,
  };

  campaigns.push(row);

  return row;
}

function addApplication(
  overrides: Partial<ApplicationRow> = {},
): ApplicationRow {
  const row: ApplicationRow = {
    id: `app-${nextId++}`,
    campaignId: campaigns[0]?.id ?? "camp-1",
    creatorId: "creator-1",
    status: "PENDING",
    message: null,
    quoteAmount: "180000.00",
    currency: "NGN",
    ...overrides,
  };

  applications.push(row);

  return row;
}

function addRateCardItem(overrides: Partial<RateCardRow> = {}): RateCardRow {
  const row: RateCardRow = {
    id: `rci-${nextId++}`,
    creatorId: "creator-1",
    platform: "TIKTOK",
    serviceType: "VIDEO",
    price: "150000.00",
    currency: "NGN",
    status: "ACTIVE",
    version: 1,
    ...overrides,
  };

  rateCardItems.push(row);

  return row;
}

const prismaStub = {
  campaign: {
    findUnique: (args: { where: { id: string }; select?: unknown }) => {
      const row = campaigns.find((c) => c.id === args.where.id);

      return Promise.resolve(row ? structuredClone(row) : null);
    },
  },
  campaignApplication: {
    findFirst: (args: { where: Record<string, unknown> }) => {
      const where = args.where as {
        id?: string;
        creatorId?: string;
        status?: string;
        campaign?: { advertiserId?: string };
      };

      const row = applications.find((a) => {
        if (where.id && a.id !== where.id) return false;
        if (where.creatorId && a.creatorId !== where.creatorId) return false;
        if (where.status && a.status !== where.status) return false;
        if (where.campaign?.advertiserId) {
          const campaign = campaigns.find((c) => c.id === a.campaignId);
          if (!campaign || campaign.advertiserId !== where.campaign.advertiserId) {
            return false;
          }
        }
        return true;
      });

      if (!row) {
        return Promise.resolve(null);
      }

      // Attach the campaign snapshot the service selects.
      const campaign = campaigns.find((c) => c.id === row.campaignId);

      return Promise.resolve(
        structuredClone({
          ...row,
          campaign: campaign
            ? {
                id: campaign.id,
                status: campaign.status,
                maxCreators: campaign.maxCreators,
                budget: campaign.budget,
                platform: campaign.platform,
                startDate: null,
                endDate: null,
                contentRequirements: null,
                applicationDeadline: null,
              }
            : undefined,
        }),
      );
    },
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const where = args.where as {
        id?: string;
        creatorId?: string;
        status?: string;
        campaign?: { advertiserId?: string };
      };

      let count = 0;

      for (const row of applications) {
        let matches =
          (!where.id || row.id === where.id) &&
          (!where.creatorId || row.creatorId === where.creatorId) &&
          (!where.status || row.status === where.status);

        if (matches && where.campaign?.advertiserId) {
          const campaign = campaigns.find((c) => c.id === row.campaignId);
          matches =
            !!campaign && campaign.advertiserId === where.campaign.advertiserId;
        }

        if (matches) {
          Object.assign(row, args.data);
          count += 1;
        }
      }

      return Promise.resolve({ count });
    },
  },
  campaignAgreement: {
    findMany: (args: { where: Record<string, unknown> }) => {
      const where = args.where as {
        status?: string;
        currency?: string;
        campaign?: { platform?: string; category?: string; id?: { not?: string } };
        campaignId?: string;
      };

      const matches = agreements.filter((a) => {
        if (where.status && a.status !== where.status) return false;
        if (where.currency && a.currency !== where.currency) return false;
        if (where.campaignId && a.campaignId !== where.campaignId) return false;
        if (where.campaign) {
          const campaign = campaigns.find((c) => c.id === a.campaignId);
          if (!campaign) return false;
          if (where.campaign.platform && campaign.platform !== where.campaign.platform) {
            return false;
          }
          if (where.campaign.category && campaign.category !== where.campaign.category) {
            return false;
          }
          if (where.campaign.id?.not && campaign.id === where.campaign.id.not) {
            return false;
          }
        }
        return true;
      });

      return Promise.resolve(matches.map((row) => structuredClone(row)));
    },
    create: (args: { data: Record<string, unknown> }) => {
      const row: AgreementRow = {
        id: `agr-${nextId++}`,
        campaignId: String(args.data.campaignId),
        applicationId: String(args.data.applicationId),
        advertiserId: String(args.data.advertiserId),
        creatorId: String(args.data.creatorId),
        status: (args.data.status as AgreementRow["status"]) ?? "ACTIVE",
        platform: String(args.data.platform),
        agreedAmount: String(args.data.agreedAmount),
        currency: String(args.data.currency),
      };

      agreements.push(row);

      return Promise.resolve({ id: row.id });
    },
  },
  rateCardItem: {
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const where = args.where as {
        id?: string;
        creatorId?: string;
        status?: string;
      };

      let count = 0;

      for (const row of rateCardItems) {
        if (
          (!where.id || row.id === where.id) &&
          (!where.creatorId || row.creatorId === where.creatorId) &&
          (!where.status || row.status === where.status)
        ) {
          Object.assign(row, args.data);
          count += 1;
        }
      }

      return Promise.resolve({ count });
    },
    findFirst: (args: { where: Record<string, unknown> }) => {
      const where = args.where as {
        id?: string;
        creatorId?: string;
        status?: string;
      };
      const row = rateCardItems.find(
        (candidate) =>
          (!where.id || candidate.id === where.id) &&
          (!where.creatorId || candidate.creatorId === where.creatorId) &&
          (!where.status || candidate.status === where.status),
      );

      return Promise.resolve(row ? structuredClone(row) : null);
    },
    create: (args: { data: Record<string, unknown> }) => {
      const row: RateCardRow = {
        id: `rci-${nextId++}`,
        creatorId: String(args.data.creatorId),
        platform: String(args.data.platform),
        serviceType: String(args.data.serviceType ?? "VIDEO"),
        price: String(args.data.price),
        currency: String(args.data.currency ?? "NGN"),
        status: (args.data.status as RateCardRow["status"]) ?? "ACTIVE",
        version: (args.data.version as number) ?? 1,
      };

      rateCardItems.push(row);

      return Promise.resolve({ id: row.id });
    },
  },
  $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(prismaStub),
};

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
mockModule("@/lib/prisma", { prisma: prismaStub });

type AdvertiserService = typeof import("@/services/advertiser.service");
type RateCardService = typeof import("@/services/rate-card.service");
type PricingGuidance = typeof import(
  "@/services/creator-pricing-guidance.service"
);

let advertiserService: AdvertiserService;
let rateCardService: RateCardService;
let pricingGuidance: PricingGuidance;

describe("Stage 12 pricing invariants", () => {
  before(async () => {
    advertiserService = await import("@/services/advertiser.service");
    rateCardService = await import("@/services/rate-card.service");
    pricingGuidance = await import(
      "@/services/creator-pricing-guidance.service"
    );
  });

  beforeEach(() => {
    resetDb();
  });

  it("accepting freezes the creator's quote and the rate card never touches it", async () => {
    addCampaign();
    const application = addApplication({ quoteAmount: "180000.00" });
    addRateCardItem({ price: "150000.00" });

    const review = await advertiserService.reviewApplication(
      "adv-1",
      application.id,
      "ACCEPT",
    );

    assert.equal(review.success, true);
    assert.equal(agreements.length, 1);
    // The AGREED amount is the creator's quote, not the listed rate.
    assert.equal(agreements[0]?.agreedAmount, "180000.00");

    // Creator later changes their rate card.
    await rateCardService.updateRateCardItem("creator-1", {
      itemId: rateCardItems[0]?.id ?? "",
      price: "250000",
      currency: "NGN",
      description: undefined,
    });

    // The accepted application and the agreement are untouched.
    assert.equal(
      applications.find((a) => a.id === application.id)?.quoteAmount,
      "180000.00",
    );
    assert.equal(agreements[0]?.agreedAmount, "180000.00");
    assert.equal(agreements[0]?.status, "ACTIVE");
  });

  it("rate-card changes do not rewrite existing applications (§10)", async () => {
    addCampaign();
    const application = addApplication({ quoteAmount: "180000.00" });
    addRateCardItem({ price: "150000.00" });

    await rateCardService.updateRateCardItem("creator-1", {
      itemId: rateCardItems[0]?.id ?? "",
      price: "250000",
      currency: "NGN",
      description: undefined,
    });

    assert.equal(
      applications.find((a) => a.id === application.id)?.quoteAmount,
      "180000.00",
    );
    assert.equal(application.quoteAmount, "180000.00");
  });

  it("advertiser has no write path to the creator's quote", async () => {
    addCampaign();

    // The review schema only carries applicationId + decision — no amount.
    const { reviewApplicationSchema } = await import("@/validation/campaign");

    const parsed = reviewApplicationSchema.safeParse({
      applicationId: "11111111-1111-4111-8111-111111111111",
      decision: "ACCEPT",
      // Malicious advertiser attempts to overwrite the quote:
      quoteAmount: "1",
      agreedAmount: "1",
    });

    // Zod strips unknown keys; the service never accepts an amount anyway.
    assert.equal(parsed.success, true);
    assert.equal(JSON.stringify(parsed.data).includes("180000"), false);
    assert.equal("quoteAmount" in parsed.data, false);
  });

  it("guidance returns INSUFFICIENT_DATA with no numbers when no history exists", async () => {
    addCampaign();

    const guidance = await pricingGuidance.getCampaignQuoteGuidance("camp-1");

    assert.equal(guidance.dataAvailability, "INSUFFICIENT_DATA");
    assert.equal(guidance.suggestedMin, null);
    assert.equal(guidance.suggestedMax, null);
  });

  it("listed rates and rejected applications never count as market history", async () => {
    addCampaign();
    // Listed rates + a REJECTED application exist; still no AGREED history.
    addRateCardItem({ price: "500000.00" });
    addApplication({ status: "REJECTED", quoteAmount: "500000.00" });

    const guidance = await pricingGuidance.getCampaignQuoteGuidance("camp-1");

    assert.equal(guidance.dataAvailability, "INSUFFICIENT_DATA");
    assert.equal(guidance.sampleSize, 0);
  });
});
