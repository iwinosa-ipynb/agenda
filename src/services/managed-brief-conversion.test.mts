import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Agenda Managed (V1, slice 5) — SELECTED candidate → DRAFT campaign
 * conversion tests (service + action boundary).
 *
 * Same harness convention as the other managed-brief suites: an in-memory
 * Prisma stub with unique-constraint simulation, ownership-in-query filters
 * and per-transaction rollback. Pins the locked product decisions:
 *   - authorization: the advertiser comes ONLY from the server session seam
 *     (requireViewerAdvertiserId); no client field can override it;
 *   - the campaign is DRAFT, platform comes from the candidate's
 *     SocialAccount, the budget is the advertiser's explicit input (never the
 *     brief's informational budgetMinor);
 *   - ONLY a Campaign + the candidate link are written — no application,
 *     agreement, obligation, milestone, payment or ledger row;
 *   - SELECTED stays terminal; the brief is untouched;
 *   - the unique campaignId is the race arbiter: a lost concurrent conversion
 *     rolls back and reports ALREADY_CONVERTED.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma stub
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { id: string };

const db: Record<string, Row[]> = {
  socialAccount: [],
  managedBrief: [],
  managedBriefSourcingCandidate: [],
  campaign: [],
  campaignApplication: [],
  campaignAgreement: [],
  financialObligation: [],
  milestone: [],
  paymentProviderTransaction: [],
  ledgerEntry: [],
};

let nextId = 1;
const id = (prefix: string) => `${prefix}-${nextId++}`;

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
      if ("in" in operators && !(operators.in as unknown[]).includes(row[key])) return false;

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
      // The service filters on the flat where-clause and selects the account
      // nested; the stub resolves the account eagerly.
      const flatWhere = { ...args.where };

      delete flatWhere.socialAccount;

      const row = db.managedBriefSourcingCandidate.find((c) => matches(c, flatWhere));

      if (!row) return null;

      const enriched = structuredClone(row);
      const account = db.socialAccount.find((a) => a.id === row.socialAccountId);

      if (account) {
        enriched.socialAccount = structuredClone(account);
      }

      // The read path selects the candidate's creator relation — resolve it
      // from the stored row shape (the DB guarantees a CreatorProfile via
      // FK; the stub mirrors that join).
      enriched.creator = enriched.creator ?? {
        username: `creator-${String(row.creatorId).slice(0, 8)}`,
        category: "FOOD",
        user: { name: `Creator ${row.creatorId}` },
      };

      return enriched;
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = db.managedBriefSourcingCandidate.find((c) => c.id === args.where.id);

      if (!row) {
        const error = new Error("not found") as Error & { code: string };

        error.code = "P2025";
        throw error;
      }

      // Unique-campaignId arbitration: a second link write onto a row that
      // already carries a DIFFERENT campaignId violates the constraint.
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
// Session seam (the action boundary's only identity source)
// ---------------------------------------------------------------------------

let sessionAdvertiserId: string | null = null;

function mockModule(specifier: string, exports: Record<string, unknown>): void {
  (mock.module as (spec: string, opts: Record<string, unknown>) => void)(
    specifier,
    { exports },
  );
}

mockModule("server-only", {});
mockModule("@/lib/prisma", { prisma: prismaStub as never });

mockModule("@/services/advertiser.service", {
  requireViewerAdvertiserId: async () => {
    if (!sessionAdvertiserId) {
      throw new Error("REDIRECTED: non-advertiser or anonymous session");
    }

    return sessionAdvertiserId;
  },
});

mockModule("next/cache", { revalidatePath: () => undefined });

// ---------------------------------------------------------------------------
// Imports (AFTER mocks)
// ---------------------------------------------------------------------------

type ConversionService = typeof import("@/services/managed-brief-conversion.service");
type ManagedBriefActions = typeof import("@/app/dashboard/_actions/managed-brief");

let conversion: ConversionService;
let actions: ManagedBriefActions;

const OWNER = "adv-owner-1";
const OTHER_ADV = "adv-other-2";

let uuidCounter = 1;

/** Deterministic valid UUID (the validation layer requires uuid shape). */
function uuid(): string {
  const n = (uuidCounter++).toString(16).padStart(12, "0");

  return `00000000-0000-4000-8000-${n}`;
}

function addBrief(overrides: Record<string, unknown> = {}): Row {
  const row: Row = {
    id: uuid(),
    advertiserId: OWNER,
    campaignGoal: "Launch the new snack line with bold creators",
    description:
      "A full brief describing the launch, tone and deliverables in the advertiser's own words.",
    budgetMinor: 500000000n, // informational only — never used by conversion
    currency: "NGN",
    targetAudience: "Lagos Gen Z snackers",
    targetPlatforms: ["TIKTOK"],
    creatorRequirements: "Bold on-camera energy",
    status: "IN_REVIEW",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };

  db.managedBrief.push(row);

  return row;
}

function addAccount(overrides: Record<string, unknown> = {}): Row {
  const row: Row = {
    id: uuid(),
    platform: "TIKTOK",
    username: "snackqueen",
    // Eligible by default: OAuth-connected (the sourcing rule the conversion
    // boundary re-checks). Tests pass platformUserId: null to model legacy
    // claimed-only accounts.
    platformUserId: `platform-${nextId}`,
    ...overrides,
  };

  db.socialAccount.push(row);

  return row;
}

function addCandidate(brief: Row, overrides: Record<string, unknown> = {}): Row {
  const row: Row = {
    id: uuid(),
    briefId: brief.id,
    creatorId: uuid(),
    // Must reference a real seeded account row: the DB enforces this FK and
    // the conversion boundary now reads the pinned account's eligibility.
    socialAccountId: db.socialAccount[0]?.id ?? uuid(),
    status: "SELECTED",
    campaignId: null,
    note: null,
    addedById: "support-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };

  db.managedBriefSourcingCandidate.push(row);

  return row;
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

function conversionForm(
  candidateId: string,
  briefId: string,
  extra: Record<string, string> = {},
): FormData {
  return formData({
    briefId,
    candidateId,
    title: "Snack line launch with creators",
    category: "FOOD",
    targetLocation: "Lagos, Nigeria",
    minimumFollowers: "5000",
    maxCreators: "1",
    budget: "750000",
    ...extra,
  });
}

describe("Agenda Managed slice 5 — SELECTED candidate → DRAFT campaign conversion", () => {
  before(async () => {
    conversion = await import("@/services/managed-brief-conversion.service");
    actions = await import("@/app/dashboard/_actions/managed-brief");
  });

  beforeEach(() => {
    resetDb();
    sessionAdvertiserId = null;
  });

  // -------------------------------------------------------------------------
  // Authorization matrix
  // -------------------------------------------------------------------------

  it("refuses when no advertiser session exists (anonymous or non-advertiser)", async () => {
    const brief = addBrief();
    const candidate = addCandidate(brief);

    await assert.rejects(
      actions.convertSelectedCandidateAction(null, conversionForm(candidate.id, brief.id)),
      /REDIRECTED/,
    );

    assert.equal(db.campaign.length, 0);
    assert.equal(candidate.campaignId, null);
  });

  it("refuses another advertiser's brief (ownership is inside the query)", async () => {
    const brief = addBrief();
    const candidate = addCandidate(brief);

    const result = await conversion.convertSelectedCandidateToDraftCampaign(OTHER_ADV, {
      ...CONVERSION_INPUT,
      briefId: brief.id,
      candidateId: candidate.id,
    });

    assert.equal(result.success, false);
    assert.equal(result.code, "BRIEF_NOT_FOUND");
    assert.equal(db.campaign.length, 0);
  });

  it("refuses a candidate from a different brief (candidate-brief pairing)", async () => {
    const brief = addBrief();
    const otherBrief = addBrief();
    const candidate = addCandidate(otherBrief);

    const result = await conversion.convertSelectedCandidateToDraftCampaign(OWNER, {
      ...CONVERSION_INPUT,
      briefId: brief.id,
      candidateId: candidate.id,
    });

    assert.equal(result.success, false);
    assert.equal(result.code, "CANDIDATE_NOT_FOUND");
    assert.equal(db.campaign.length, 0);
  });

  it("refuses a non-SELECTED candidate", async () => {
    const brief = addBrief();
    const candidate = addCandidate(brief, { status: "INTERESTED" });

    const result = await conversion.convertSelectedCandidateToDraftCampaign(OWNER, {
      ...CONVERSION_INPUT,
      briefId: brief.id,
      candidateId: candidate.id,
    });

    assert.equal(result.success, false);
    assert.equal(result.code, "NOT_SELECTED");
    assert.equal(db.campaign.length, 0);
  });

  // ---------------------------------------------------------------------------
  // Sourcing eligibility — conversion refuses a pinned account that cannot
  // satisfy the marketplace application gate (connectable platform + OAuth-
  // connected). No Campaign is created in any refusal case.
  // ---------------------------------------------------------------------------

  it("converts a TIKTOK connected account (eligible)", async () => {
    const brief = addBrief();
    const account = addAccount({ platform: "TIKTOK", platformUserId: "tt-1" });
    const candidate = addCandidate(brief, { socialAccountId: account.id });

    const result = await conversion.convertSelectedCandidateToDraftCampaign(OWNER, {
      ...CONVERSION_INPUT,
      briefId: brief.id,
      candidateId: candidate.id,
    });

    assert.equal(result.success, true);
    assert.equal(db.campaign[0]?.platform, "TIKTOK");
  });

  it("converts an X connected account (eligible)", async () => {
    const brief = addBrief();
    const account = addAccount({ platform: "X", platformUserId: "x-1" });
    const candidate = addCandidate(brief, { socialAccountId: account.id });

    const result = await conversion.convertSelectedCandidateToDraftCampaign(OWNER, {
      ...CONVERSION_INPUT,
      briefId: brief.id,
      candidateId: candidate.id,
    });

    assert.equal(result.success, true);
    assert.equal(db.campaign[0]?.platform, "X");
  });

  it("refuses a TIKTOK claimed-only account (platformUserId null) and creates no campaign", async () => {
    const brief = addBrief();
    const account = addAccount({ platform: "TIKTOK", platformUserId: null });
    const candidate = addCandidate(brief, { socialAccountId: account.id });

    const result = await conversion.convertSelectedCandidateToDraftCampaign(OWNER, {
      ...CONVERSION_INPUT,
      briefId: brief.id,
      candidateId: candidate.id,
    });

    assert.equal(result.success, false);
    assert.equal(result.code, "INELIGIBLE_ACCOUNT");
    assert.equal(db.campaign.length, 0);
    assert.equal(candidate.campaignId, null);
    // The pinned account is untouched — no swap, no rewrite.
    assert.equal(db.socialAccount.find((a) => a.id === account.id)?.platformUserId, null);
  });

  it("refuses an X claimed-only account (platformUserId null) and creates no campaign", async () => {
    const brief = addBrief();
    const account = addAccount({ platform: "X", platformUserId: null });
    const candidate = addCandidate(brief, { socialAccountId: account.id });

    const result = await conversion.convertSelectedCandidateToDraftCampaign(OWNER, {
      ...CONVERSION_INPUT,
      briefId: brief.id,
      candidateId: candidate.id,
    });

    assert.equal(result.success, false);
    assert.equal(result.code, "INELIGIBLE_ACCOUNT");
    assert.equal(db.campaign.length, 0);
  });

  it("refuses an unsupported platform (INSTAGRAM) even when connected and creates no campaign", async () => {
    const brief = addBrief();
    const account = addAccount({
      platform: "INSTAGRAM",
      platformUserId: "ig-1",
    });
    const candidate = addCandidate(brief, { socialAccountId: account.id });

    const result = await conversion.convertSelectedCandidateToDraftCampaign(OWNER, {
      ...CONVERSION_INPUT,
      briefId: brief.id,
      candidateId: candidate.id,
    });

    assert.equal(result.success, false);
    assert.equal(result.code, "INELIGIBLE_ACCOUNT");
    assert.equal(db.campaign.length, 0);
  });

  it("the eligibility read flags a legacy claimed-only pinned account", async () => {
    const brief = addBrief();
    const account = addAccount({ platform: "X", platformUserId: null });
    addCandidate(brief, { socialAccountId: account.id, status: "SELECTED" });

    const read = await conversion.getSelectedCandidateForConversion(OWNER, brief.id);

    assert.ok(read);
    assert.equal(read.accountEligible, false);
  });

  it("the eligibility read flags a connected account as eligible", async () => {
    const brief = addBrief();
    const account = addAccount({ platform: "TIKTOK", platformUserId: "tt-9" });
    addCandidate(brief, { socialAccountId: account.id, status: "SELECTED" });

    const read = await conversion.getSelectedCandidateForConversion(OWNER, brief.id);

    assert.ok(read);
    assert.equal(read.accountEligible, true);
  });

  it("refuses an already-converted candidate", async () => {
    const brief = addBrief();
    const candidate = addCandidate(brief, { campaignId: "existing-campaign-1" });

    const result = await conversion.convertSelectedCandidateToDraftCampaign(OWNER, {
      ...CONVERSION_INPUT,
      briefId: brief.id,
      candidateId: candidate.id,
    });

    assert.equal(result.success, false);
    assert.equal(result.code, "ALREADY_CONVERTED");
    assert.equal(db.campaign.length, 0);
  });

  it("client-supplied advertiserId cannot override session ownership", async () => {
    const brief = addBrief();
    const account = addAccount();
    const candidate = addCandidate(brief, { socialAccountId: account.id });

    sessionAdvertiserId = OWNER;

    // The action derives the advertiser from the session; a form field named
    // advertiserId is never read.
    const result = await actions.convertSelectedCandidateAction(
      null,
      conversionForm(candidate.id, brief.id, { advertiserId: OTHER_ADV }),
    );

    assert.equal(result.success, true);
    assert.equal(db.campaign[0].advertiserId, OWNER);
  });

  it("client-supplied ids cannot bypass brief ownership (foreign brief + own session)", async () => {
    const foreignBrief = addBrief({ advertiserId: OTHER_ADV });
    const foreignCandidate = addCandidate(foreignBrief);

    const result = await conversion.convertSelectedCandidateToDraftCampaign(OWNER, {
      ...CONVERSION_INPUT,
      briefId: foreignBrief.id,
      candidateId: foreignCandidate.id,
    });

    assert.equal(result.success, false);
    assert.equal(result.code, "BRIEF_NOT_FOUND");
    assert.equal(db.campaign.length, 0);
  });

  // -------------------------------------------------------------------------
  // Mapping / business rules
  // -------------------------------------------------------------------------

  it("creates a DRAFT campaign owned by the session advertiser with platform from the SocialAccount", async () => {
    const brief = addBrief();
    const account = addAccount({ platform: "X" });
    const candidate = addCandidate(brief, { socialAccountId: account.id });

    const result = await conversion.convertSelectedCandidateToDraftCampaign(OWNER, {
      ...CONVERSION_INPUT,
      briefId: brief.id,
      candidateId: candidate.id,
    });

    assert.equal(result.success, true);

    const campaign = db.campaign[0];

    assert.equal(campaign.status, "DRAFT");
    assert.equal(campaign.advertiserId, OWNER);
    assert.equal(campaign.platform, "X"); // from the account, not free text
    assert.equal(campaign.title, CONVERSION_INPUT.title);
    assert.equal(campaign.category, "FOOD");
    assert.equal(campaign.targetLocation, "Lagos, Nigeria");
    assert.equal(campaign.budget, "750000.00"); // explicit input
    assert.notEqual(campaign.budget, String(brief.budgetMinor));
    assert.equal(campaign.pricePerThousandViews, "0.00"); // CPM stays retired
    assert.equal(campaign.maxCreators, 1);
  });

  it("links the campaign back to the candidate and preserves the candidate + brief", async () => {
    const brief = addBrief();
    const account = addAccount();
    const candidate = addCandidate(brief, { socialAccountId: account.id });

    const result = await conversion.convertSelectedCandidateToDraftCampaign(OWNER, {
      ...CONVERSION_INPUT,
      briefId: brief.id,
      candidateId: candidate.id,
    });

    assert.equal(result.success, true);

    const stored = db.managedBriefSourcingCandidate.find((c) => c.id === candidate.id);

    assert.equal(stored?.campaignId, result.data.campaignId);
    assert.equal(stored?.status, "SELECTED"); // still terminal SELECTED
    assert.equal(brief.status, "IN_REVIEW"); // brief untouched
    assert.equal(db.managedBrief.length, 1);
  });

  it("creates NO application, agreement, obligation, milestone, payment or ledger row", async () => {
    const brief = addBrief();
    const account = addAccount();
    const candidate = addCandidate(brief, { socialAccountId: account.id });

    const result = await conversion.convertSelectedCandidateToDraftCampaign(OWNER, {
      ...CONVERSION_INPUT,
      briefId: brief.id,
      candidateId: candidate.id,
    });

    assert.equal(result.success, true);
    assert.equal(db.campaign.length, 1);
    assert.equal(db.campaignApplication.length, 0);
    assert.equal(db.campaignAgreement.length, 0);
    assert.equal(db.financialObligation.length, 0);
    assert.equal(db.milestone.length, 0);
    assert.equal(db.paymentProviderTransaction.length, 0);
    assert.equal(db.ledgerEntry.length, 0);
  });

  // -------------------------------------------------------------------------
  // Concurrency / duplicates
  // -------------------------------------------------------------------------

  it("a lost concurrent conversion rolls back and reports ALREADY_CONVERTED", async () => {
    const brief = addBrief();
    const account = addAccount();
    const candidate = addCandidate(brief, { socialAccountId: account.id });

    // Simulate the race: another request claims the unique campaignId between
    // the service's pre-check and its link write. The stub's update throws
    // P2002 once, which must roll back the transaction (no campaign row may
    // survive) and surface ALREADY_CONVERTED.
    const candidateModel = prismaStub.managedBriefSourcingCandidate as Record<string, unknown>;
    const originalUpdate = candidateModel.update;

    candidateModel.update = async () => {
      throw uniqueError();
    };

    try {
      const result = await conversion.convertSelectedCandidateToDraftCampaign(OWNER, {
        ...CONVERSION_INPUT,
        briefId: brief.id,
        candidateId: candidate.id,
      });

      assert.equal(result.success, false);
      assert.equal(result.code, "ALREADY_CONVERTED");
    } finally {
      candidateModel.update = originalUpdate;
    }

    // The transaction rolled back: no campaign row remains, no link written.
    assert.equal(db.campaign.length, 0);
    assert.equal(candidate.campaignId, null);
  });

  it("duplicate sequential conversion is refused and leaves exactly one campaign", async () => {
    const brief = addBrief();
    const account = addAccount();
    const candidate = addCandidate(brief, { socialAccountId: account.id });

    const first = await conversion.convertSelectedCandidateToDraftCampaign(OWNER, {
      ...CONVERSION_INPUT,
      briefId: brief.id,
      candidateId: candidate.id,
    });

    assert.equal(first.success, true);

    const second = await conversion.convertSelectedCandidateToDraftCampaign(OWNER, {
      ...CONVERSION_INPUT,
      briefId: brief.id,
      candidateId: candidate.id,
    });

    assert.equal(second.success, false);
    assert.equal(second.code, "ALREADY_CONVERTED");
    assert.equal(db.campaign.length, 1);
  });

  // -------------------------------------------------------------------------
  // Action boundary: field parsing + data mapping
  // -------------------------------------------------------------------------

  it("the action persists the advertiser-entered fields (hostile fields are ignored)", async () => {
    const brief = addBrief();
    const account = addAccount();
    const candidate = addCandidate(brief, { socialAccountId: account.id });

    sessionAdvertiserId = OWNER;

    const result = await actions.convertSelectedCandidateAction(
      null,
      conversionForm(candidate.id, brief.id, {
        quoteAmount: "1", // hostile: no quote field exists on conversion
        pricePerThousandViews: "99", // hostile: CPM stays retired
        status: "PUBLISHED", // hostile: conversion never publishes
      }),
    );

    assert.equal(result.success, true);
    assert.equal(db.campaign[0].status, "DRAFT"); // never PUBLISHED from input
    assert.equal(db.campaign[0].pricePerThousandViews, "0.00");
    assert.equal(db.campaignApplication.length, 0); // no application for the creator
  });

  it("the action rejects invalid conversion fields with field errors and no campaign", async () => {
    const brief = addBrief();
    const candidate = addCandidate(brief);

    sessionAdvertiserId = OWNER;

    const result = await actions.convertSelectedCandidateAction(
      null,
      formData({
        briefId: brief.id,
        candidateId: candidate.id,
        title: "no",
        category: "NOT_A_CATEGORY",
        targetLocation: "L",
        budget: "-5",
      }),
    );

    assert.equal(result.success, false);
    assert.ok(result.fieldErrors);
    assert.equal(db.campaign.length, 0);
  });
});
