import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Stage 14A — advertiser funding-preparation tests (service layer, in-memory
 * Prisma). Uses the established pattern (no DATABASE_URL): a behavior-faithful
 * stub with unique-constraint simulation AND transaction rollback, registered
 * via mock.module BEFORE the modules under test are imported.
 *
 * Pins:
 *   - successful preparation: obligation stays PENDING_PAYMENT (never FUNDED,
 *     no escrow, no ledger movement) and milestones are planned explicitly;
 *   - milestone amounts reconcile EXACTLY to the frozen agreement amount;
 *   - advertiser ownership + agreement state are enforced fail-closed inside
 *     the queries (creators / foreign advertisers / non-ACTIVE agreements get
 *     the same indistinguishable refusal);
 *   - duplicate preparation is refused (pre-check AND lost unique race);
 *   - concurrent preparations converge to exactly one winner;
 *   - a milestone-planning failure rolls back the WHOLE transaction — no
 *     orphan obligation, no partial milestones — and a retry succeeds;
 *   - zero/negative/malformed/under/over-allocated terms are refused;
 *   - FEE_NOT_CONFIGURED fails closed before any write;
 *   - the validation schema rejects malformed milestone terms.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma stub
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { id: string };

const db: Record<string, Row[]> = {
  campaignAgreement: [],
  financialObligation: [],
  financialEvent: [],
  ledgerEntry: [],
  milestone: [],
  milestoneEvent: [],
  platformFeeConfig: [],
};

let nextId = 1;
const id = (prefix: string) => `${prefix}-${nextId++}`;

/** Fault injection for the rollback test. */
let failNextMilestoneCreate = false;

/** Writes performed by the transaction currently running (for its rollback). */
let transactionWrites: Array<{ table: string; row: Row }> = [];

/**
 * Concurrency gate: when set, the next obligation create pauses until the
 * promise resolves — letting a sibling transaction run to completion first,
 * so the race loser rolls back against a committed winner.
 */
let pauseNextObligationCreate: Promise<void> | null = null;

function resetDb(): void {
  for (const table of Object.keys(db)) {
    db[table] = [];
  }

  nextId = 1;
  failNextMilestoneCreate = false;
  pauseNextObligationCreate = null;
  transactionWrites = [];
}

function uniqueError(): Error {
  const error = new Error("Unique constraint failed") as Error & { code: string };

  error.code = "P2002";

  return error;
}

function enforceUnique(table: string, row: Row, keys: string[][]): void {
  for (const key of keys) {
    const value = key.map((field) => String(row[field] ?? null)).join("|");

    if (value === key.map(() => "null").join("|")) {
      continue;
    }

    const duplicate = db[table].some(
      (existing) =>
        key.map((field) => String(existing[field] ?? null)).join("|") === value,
    );

    if (duplicate) {
      throw uniqueError();
    }
  }
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (condition === null || condition === undefined) {
      continue;
    }

    if (typeof condition === "object" && !Array.isArray(condition)) {
      const operators = condition as Record<string, unknown>;

      if ("in" in operators && !(operators.in as unknown[]).includes(row[key])) return false;
      if ("not" in operators && row[key] === operators.not) return false;

      continue;
    }

    if (row[key] !== condition) {
      return false;
    }
  }

  return true;
}

/**
 * Flatten Prisma nested-relation create input the way the real database
 * does: `agreement: { connect: { id } }` persists as the FK `agreementId`.
 */
function flattenRelationInput(row: Row): void {
  for (const key of Object.keys(row)) {
    const value = row[key];

    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      !(value instanceof Date)
    ) {
      const connect = (value as Record<string, unknown>).connect;

      if (typeof connect === "object" && connect !== null && "id" in connect) {
        row[`${key}Id`] = (connect as { id: string }).id;
        delete row[key];
      }
    }
  }
}

const prismaStub = {
  campaignAgreement: {
    findUnique: async (args: { where: { id: string } }) => {
      const row = db.campaignAgreement.find((a) => a.id === args.where.id);

      return row ? structuredClone(row) : null;
    },
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const row = db.campaignAgreement.find((a) => matches(a, args.where));

      return row ? structuredClone(row) : null;
    },
  },
  financialObligation: {
    findUnique: async (args: { where: { id?: string; agreementId?: string } }) => {
      const row = db.financialObligation.find(
        (o) =>
          (args.where.id === undefined || o.id === args.where.id) &&
          (args.where.agreementId === undefined || o.agreementId === args.where.agreementId),
      );

      return row ? structuredClone(row) : null;
    },
    create: async (args: { data: Record<string, unknown> }) => {
      if (pauseNextObligationCreate) {
        const gate = pauseNextObligationCreate;

        pauseNextObligationCreate = null;
        await gate;
      }

      const row = {
        // Schema defaults the real database applies.
        escrowFunded: false,
        dispute: false,
        ...args.data,
        id: typeof args.data.id === "string" ? args.data.id : id("obligation"),
      } as Row;

      enforceUnique("financialObligation", row, [["agreementId"], ["obligationRef"], ["id"]]);
      db.financialObligation.push(row);
      transactionWrites.push({ table: "financialObligation", row });

      return structuredClone(row);
    },
  },
  financialEvent: {
    create: async (args: { data: Record<string, unknown> }) => {
      const row = {
        ...args.data,
        id: typeof args.data.id === "string" ? args.data.id : id("fevt"),
      } as Row;

      enforceUnique("financialEvent", row, [["idempotencyKey"], ["id"]]);
      db.financialEvent.push(row);
      transactionWrites.push({ table: "financialEvent", row });

      return structuredClone(row);
    },
    findMany: async (args: { where?: Record<string, unknown> }) => {
      const rows = db.financialEvent.filter((e) =>
        args.where ? matches(e, args.where) : true,
      );

      return structuredClone(rows);
    },
  },
  ledgerEntry: {
    findMany: async () => structuredClone(db.ledgerEntry),
  },
  milestone: {
    count: async (args: { where: Record<string, unknown> }) => {
      return db.milestone.filter((m) => matches(m, args.where)).length;
    },
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const row = db.milestone.find((m) => matches(m, args.where));

      return row ? structuredClone(row) : null;
    },
    findMany: async (args: { where?: Record<string, unknown> }) => {
      const rows = db.milestone.filter((m) =>
        args.where ? matches(m, args.where) : true,
      );

      return structuredClone(rows);
    },
    create: async (args: { data: Record<string, unknown> }) => {
      if (failNextMilestoneCreate) {
        failNextMilestoneCreate = false;
        throw new Error("injected milestone-create failure");
      }

      const row = {
        status: "PENDING",
        requiredPostCount: 1,
        ...args.data,
        id: typeof args.data.id === "string" ? args.data.id : id("milestone"),
      } as Row;

      flattenRelationInput(row);
      enforceUnique("milestone", row, [
        ["agreementId", "position"],
        ["milestoneRef"],
        ["id"],
      ]);
      db.milestone.push(row);
      transactionWrites.push({ table: "milestone", row });

      return structuredClone(row);
    },
  },
  milestoneEvent: {
    createMany: async (args: { data: Array<Record<string, unknown>> }) => {
      let count = 0;

      for (const data of args.data) {
        const row = {
          ...data,
          id: typeof data.id === "string" ? data.id : id("mevt"),
        } as Row;

        enforceUnique("milestoneEvent", row, [["idempotencyKey"], ["id"]]);
        db.milestoneEvent.push(row);
        count += 1;
      }

      return { count };
    },
  },
  platformFeeConfig: {
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const row = db.platformFeeConfig.find((c) => matches(c, args.where));

      return row ? structuredClone(row) : null;
    },
  },
  // Transactions roll back exactly the rows the failed transaction wrote —
  // a refused preparation must leave NO partial writes, like the real DB.
  // Writes are tracked per transaction so concurrent transactions that COMMIT
  // successfully keep their rows when a sibling rolls back.
  $transaction: async (input: unknown) => {
    const previousWrites = transactionWrites;

    transactionWrites = [];

    try {
      // Callback form: fn(tx). Array form: sequential promises.
      if (typeof input === "function") {
        return await (input as (tx: unknown) => Promise<unknown>)(prismaStub);
      }

      if (Array.isArray(input)) {
        const results: unknown[] = [];

        for (const promise of input) {
          results.push(await promise);
        }

        return results;
      }

      throw new TypeError("unsupported $transaction form");
    } catch (error) {
      // Remove only the rows this transaction wrote (interleaved commits from
      // concurrent transactions are preserved, like row-level MVCC).
      const ownWrites = transactionWrites;

      transactionWrites = previousWrites;

      for (const { table, row } of ownWrites.reverse()) {
        const tableRows = db[table];
        const index = tableRows.indexOf(row);

        if (index !== -1) {
          tableRows.splice(index, 1);
        }
      }

      throw error;
    } finally {
      // After any transaction completes, tracking starts fresh.
      transactionWrites = [];
    }
  },
} as unknown as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Module mocks (before importing modules under test)
// ---------------------------------------------------------------------------

function mockModule(specifier: string, exports: Record<string, unknown>): void {
  (mock.module as (spec: string, opts: Record<string, unknown>) => void)(
    specifier,
    { exports },
  );
}

mockModule("server-only", {});
mockModule("@/lib/prisma", { prisma: prismaStub as never });

type FundingService = typeof import("@/services/payments/funding.service");
type FundingValidation = typeof import("@/validation/funding");

let fundingService: FundingService;
let fundingValidation: FundingValidation;

const ADV = "adv-1";
const ADV_OTHER = "adv-other";
const CREATOR = "creator-1";

function addAgreement(overrides: Record<string, unknown> = {}): Row {
  const row: Row = {
    id: id("agr"),
    agreedAmount: "900000.00",
    currency: "NGN",
    campaignId: id("camp"),
    advertiserId: ADV,
    creatorId: CREATOR,
    status: "ACTIVE",
    ...overrides,
  };

  db.campaignAgreement.push(row);

  return row;
}

function addFeeConfigs(): void {
  db.platformFeeConfig.push(
    {
      id: "fee-funding-1500",
      feeBasisPoints: 1500,
      currency: "NGN",
      feeType: "AGREEMENT_FUNDING",
      status: "ACTIVE",
    } as Row,
    {
      id: "fee-adv-500",
      feeBasisPoints: 500,
      currency: "NGN",
      feeType: "MILESTONE_ADVERTISER_FEE",
      status: "ACTIVE",
    } as Row,
    {
      id: "fee-creator-1000",
      feeBasisPoints: 1000,
      currency: "NGN",
      feeType: "MILESTONE_CREATOR_FEE",
      status: "ACTIVE",
    } as Row,
  );
}

/** Explicit terms for a ₦900,000 agreement: 200k / 300k / 400k. */
function threeMilestoneTerms() {
  return [
    { position: 1, title: "Launch", creatorAmount: "200000.00" },
    { position: 2, title: "Mid", creatorAmount: "300000.00" },
    { position: 3, title: "Finale", creatorAmount: "400000.00" },
  ];
}

function wholeAmountTerm() {
  return [{ position: 1, title: "Whole", creatorAmount: "900000.00" }];
}

describe("Stage 14A — advertiser funding preparation", () => {
  before(async () => {
    fundingService = await import("@/services/payments/funding.service");
    fundingValidation = await import("@/validation/funding");
  });

  beforeEach(() => {
    resetDb();
    addFeeConfigs();
  });

  // -----------------------------------------------------------------------
  // Successful preparation
  // -----------------------------------------------------------------------

  describe("successful funding preparation", () => {
    it("creates the obligation and the explicit milestones", async () => {
      const agreement = addAgreement();

      const result = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        { milestones: threeMilestoneTerms() },
      );

      assert.equal(result.ok, true);

      if (result.ok) {
        assert.equal(result.creatorAmountMinor, 90000000n); // ₦900,000
        // A THREE-milestone agreement is MILESTONE mode: the advertiser funds
        // ONLY the creator's agreed money. NO AGREEMENT_FUNDING fee is charged
        // upfront — the 5% MILESTONE_ADVERTISER_FEE is collected per milestone
        // at settlement instead, so the two 5% fees can never both apply.
        assert.equal(result.platformFeeMinor, 0n);
        assert.equal(result.advertiserTotalMinor, 90000000n);
        assert.equal(result.currency, "NGN");
        assert.equal(result.milestones.length, 3);
        assert.deepEqual(
          result.milestones.map((m) => m.creatorAmountMinor),
          [20000000n, 30000000n, 40000000n],
        );
      }

      assert.equal(db.financialObligation.length, 1);
      assert.equal(db.milestone.length, 3);
      // No funding-fee config is snapshotted onto a MILESTONE obligation.
      assert.equal(db.financialObligation[0].feeConfigId, null);
    });

    it("a SINGLE-milestone agreement charges the AGREEMENT_FUNDING fee upfront and no milestone fee", async () => {
      const agreement = addAgreement();

      const result = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        { milestones: wholeAmountTerm() },
      );

      assert.equal(result.ok, true);

      if (result.ok) {
        assert.equal(result.creatorAmountMinor, 90000000n); // ₦900,000
        assert.equal(result.platformFeeMinor, 13500000n); // 15% AGREEMENT_FUNDING
        assert.equal(result.advertiserTotalMinor, 103500000n);
        assert.equal(result.milestones.length, 1);
      }

      const milestone = db.milestone[0];

      // The per-milestone advertiser fee MUST be zero — the funding fee
      // already charged the advertiser on this exact amount.
      assert.equal(milestone.advertiserServiceFeeMinor, 0n);
      assert.equal(milestone.advertiserFeeConfigId, null);
      assert.notEqual(db.financialObligation[0].feeConfigId, null);
    });

    it("NEVER marks anything funded: obligation stays PENDING_PAYMENT with no escrow and no ledger movement", async () => {
      const agreement = addAgreement();

      await fundingService.prepareFundingForAgreement(agreement.id as string, ADV, {
        milestones: wholeAmountTerm(),
      });

      const obligation = db.financialObligation[0];

      assert.equal(obligation.status, "PENDING_PAYMENT");
      assert.equal(obligation.escrowFunded, false);
      // No money moved — preparation is not a payment.
      assert.equal(db.ledgerEntry.length, 0);
      // The creation event is the only financial record.
      assert.equal(db.financialEvent.length, 1);
      assert.equal(db.financialEvent[0].eventType, "obligation_created");
    });

    it("milestone amounts reconcile EXACTLY to the obligation amount", async () => {
      const agreement = addAgreement();

      const result = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        { milestones: threeMilestoneTerms() },
      );

      assert.equal(result.ok, true);

      const obligation = db.financialObligation[0];
      const sum = db.milestone.reduce<bigint>(
        (total, milestone) => total + (milestone.creatorAmountMinor as bigint),
        0n,
      );

      assert.equal(sum, obligation.creatorAmountMinor);
      assert.equal(sum, 90000000n);
    });

    it("milestone fees derive from each milestone's own amount (5% / 10% config)", async () => {
      const agreement = addAgreement();

      await fundingService.prepareFundingForAgreement(agreement.id as string, ADV, {
        milestones: threeMilestoneTerms(),
      });

      const first = db.milestone.find((m) => m.position === 1) as Row;

      // 5% of ₦200,000 = ₦10,000; 10% = ₦20,000; advertiser total ₦210,000.
      assert.equal(first.advertiserServiceFeeMinor, 1000000n);
      assert.equal(first.creatorCommissionMinor, 2000000n);
      assert.equal(first.advertiserTotalMinor, 21000000n);
    });

    it("a single explicit milestone covering the whole amount is accepted", async () => {
      const agreement = addAgreement();

      const result = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        { milestones: wholeAmountTerm() },
      );

      assert.equal(result.ok, true);
      assert.equal(db.milestone.length, 1);
      assert.equal(db.milestone[0].creatorAmountMinor, 90000000n);
    });

    it("status read shows the obligation awaiting payment (never paid)", async () => {
      const agreement = addAgreement();

      await fundingService.prepareFundingForAgreement(agreement.id as string, ADV, {
        milestones: wholeAmountTerm(),
      });

      const status = await fundingService.getFundingStatusForAdvertiser(
        agreement.id as string,
        ADV,
      );

      assert.ok(status);
      assert.ok(status.obligation);
      assert.equal(status.obligation.status, "PENDING_PAYMENT");
      assert.equal(status.obligation.escrowFunded, false);
      assert.equal(status.milestones.length, 1);
    });
  });

  // -----------------------------------------------------------------------
  // Authorization & agreement state (fail closed)
  // -----------------------------------------------------------------------

  describe("ownership and state enforcement", () => {
    it("a foreign advertiser gets the same NOT_FOUND as a missing agreement", async () => {
      const agreement = addAgreement();

      const result = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV_OTHER,
        { milestones: wholeAmountTerm() },
      );

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "NOT_FOUND");
      }

      assert.equal(db.financialObligation.length, 0);
      assert.equal(db.milestone.length, 0);
    });

    it("a creator profile id can never prepare funding", async () => {
      const agreement = addAgreement();

      const result = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        CREATOR,
        { milestones: wholeAmountTerm() },
      );

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "NOT_FOUND");
      }

      assert.equal(db.financialObligation.length, 0);
    });

    it("non-ACTIVE agreements are refused (COMPLETED)", async () => {
      const agreement = addAgreement({ status: "COMPLETED" });

      const result = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        { milestones: wholeAmountTerm() },
      );

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "NOT_FOUND");
      }

      assert.equal(db.financialObligation.length, 0);
    });

    it("non-ACTIVE agreements are refused (CANCELLED)", async () => {
      const agreement = addAgreement({ status: "CANCELLED" });

      const result = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        { milestones: wholeAmountTerm() },
      );

      assert.equal(result.ok, false);
      assert.equal(db.financialObligation.length, 0);
    });

    it("status read is party-scoped: another advertiser sees null", async () => {
      const agreement = addAgreement();

      await fundingService.prepareFundingForAgreement(agreement.id as string, ADV, {
        milestones: wholeAmountTerm(),
      });

      const foreign = await fundingService.getFundingStatusForAdvertiser(
        agreement.id as string,
        ADV_OTHER,
      );

      assert.equal(foreign, null);
    });
  });

  // -----------------------------------------------------------------------
  // Duplicate preparation & concurrency
  // -----------------------------------------------------------------------

  describe("duplicate preparation and concurrency", () => {
    it("a second preparation is refused with ALREADY_PREPARED", async () => {
      const agreement = addAgreement();

      const first = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        { milestones: wholeAmountTerm() },
      );

      assert.equal(first.ok, true);

      const second = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        { milestones: wholeAmountTerm() },
      );

      assert.equal(second.ok, false);

      if (!second.ok) {
        assert.equal(second.code, "ALREADY_PREPARED");
      }

      assert.equal(db.financialObligation.length, 1);
      assert.equal(db.milestone.length, 1);
    });

    it("an existing obligation alone blocks preparation", async () => {
      const agreement = addAgreement();

      db.financialObligation.push({
        id: id("obligation"),
        agreementId: agreement.id,
        status: "PENDING_PAYMENT",
        escrowFunded: false,
      } as Row);

      const result = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        { milestones: wholeAmountTerm() },
      );

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "ALREADY_PREPARED");
      }
    });

    it("existing milestones alone block preparation", async () => {
      const agreement = addAgreement();

      db.milestone.push({
        id: id("milestone"),
        agreementId: agreement.id,
        position: 1,
        milestoneRef: "MIL-X-1",
        creatorAmountMinor: 90000000n,
        status: "PENDING",
      } as Row);

      const result = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        { milestones: wholeAmountTerm() },
      );

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "ALREADY_PREPARED");
      }
    });

    it("concurrent preparations converge: the unique constraint arbitrates and the winner's rows survive the loser's rollback", async () => {
      const agreement = addAgreement();

      // Deterministic race: the first call pauses at the obligation INSERT
      // (both have already passed their pre-checks), the second runs to
      // completion and wins, then the first resumes, loses the unique
      // constraint and must report ALREADY_PREPARED — without removing the
      // winner's committed rows.
      let releaseLoser: () => void = () => undefined;

      pauseNextObligationCreate = new Promise<void>((resolve) => {
        releaseLoser = resolve;
      });

      const loserPromise = fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        { milestones: wholeAmountTerm() },
      );

      // Let the loser reach its paused obligation create.
      await new Promise((resolve) => setTimeout(resolve, 0));

      const winner = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        { milestones: wholeAmountTerm() },
      );

      assert.equal(winner.ok, true);

      releaseLoser();

      const loser = await loserPromise;

      assert.equal(loser.ok, false);

      if (!loser.ok) {
        assert.equal(loser.code, "ALREADY_PREPARED");
      }

      assert.equal(db.financialObligation.length, 1);
      assert.equal(db.milestone.length, 1);

      const obligation = db.financialObligation[0];

      assert.equal(obligation.status, "PENDING_PAYMENT");
      assert.equal(db.milestone[0].agreementId, obligation.agreementId);
    });
  });

  // -----------------------------------------------------------------------
  // Reconciliation & term validation
  // -----------------------------------------------------------------------

  describe("milestone reconciliation", () => {
    it("under-allocation is refused and nothing is written", async () => {
      const agreement = addAgreement();

      const result = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        {
          milestones: [
            { position: 1, creatorAmount: "200000.00" },
            { position: 2, creatorAmount: "300000.00" },
          ],
        },
      );

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "INVALID_TERMS");
        assert.match(result.reason, /do not yet cover/);
      }

      assert.equal(db.financialObligation.length, 0);
      assert.equal(db.milestone.length, 0);
    });

    it("over-allocation is refused and nothing is written", async () => {
      const agreement = addAgreement();

      const result = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        {
          milestones: [
            { position: 1, creatorAmount: "500000.00" },
            { position: 2, creatorAmount: "500000.00" },
          ],
        },
      );

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "INVALID_TERMS");
        assert.match(result.reason, /exceed/);
      }

      assert.equal(db.financialObligation.length, 0);
    });

    it("a zero milestone amount is refused", async () => {
      const agreement = addAgreement();

      const result = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        {
          milestones: [
            { position: 1, creatorAmount: "0.00" },
            { position: 2, creatorAmount: "900000.00" },
          ],
        },
      );

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "INVALID_TERMS");
        assert.match(result.reason, /greater than zero/);
      }

      assert.equal(db.financialObligation.length, 0);
    });

    it("a negative milestone amount is refused", async () => {
      const agreement = addAgreement();

      const result = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        {
          milestones: [
            { position: 1, creatorAmount: "-100.00" },
            { position: 2, creatorAmount: "900100.00" },
          ],
        },
      );

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "INVALID_TERMS");
      }

      assert.equal(db.financialObligation.length, 0);
    });

    it("a malformed milestone amount (>2 decimal places) is refused", async () => {
      const agreement = addAgreement();

      const result = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        {
          milestones: [
            { position: 1, creatorAmount: "899999.999" },
            { position: 2, creatorAmount: "0.001" },
          ],
        },
      );

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "INVALID_TERMS");
      }

      assert.equal(db.financialObligation.length, 0);
    });

    it("duplicate milestone positions are refused", async () => {
      const agreement = addAgreement();

      const result = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        {
          milestones: [
            { position: 1, creatorAmount: "450000.00" },
            { position: 1, creatorAmount: "450000.00" },
          ],
        },
      );

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "INVALID_TERMS");
      }

      assert.equal(db.financialObligation.length, 0);
    });

    it("gapped milestone positions are refused", async () => {
      const agreement = addAgreement();

      const result = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        {
          milestones: [
            { position: 1, creatorAmount: "450000.00" },
            { position: 3, creatorAmount: "450000.00" },
          ],
        },
      );

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "INVALID_TERMS");
      }
    });
  });

  // -----------------------------------------------------------------------
  // Fail-closed fees & transactional rollback
  // -----------------------------------------------------------------------

  describe("fee configuration and rollback", () => {
    it("FEE_NOT_CONFIGURED fails closed before any write", async () => {
      db.platformFeeConfig.length = 0;

      const agreement = addAgreement();

      const result = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        { milestones: wholeAmountTerm() },
      );

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "FEE_NOT_CONFIGURED");
      }

      assert.equal(db.financialObligation.length, 0);
      assert.equal(db.milestone.length, 0);
      assert.equal(db.financialEvent.length, 0);
    });

    it("a milestone-planning failure rolls back the WHOLE transaction — no orphan obligation", async () => {
      const agreement = addAgreement();

      // Terms are valid, so the pre-checks pass; inject the failure at the
      // milestone INSERT inside the transaction.
      failNextMilestoneCreate = true;

      const result = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        { milestones: wholeAmountTerm() },
      );

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "CONCURRENT_CONFLICT");
        assert.match(result.reason, /Nothing was recorded/);
      }

      // The obligation (and its creation event) written moments earlier is
      // gone — the rollback is complete, nothing to clean up.
      assert.equal(db.financialObligation.length, 0);
      assert.equal(db.milestone.length, 0);
      assert.equal(db.financialEvent.length, 0);
      assert.equal(db.milestoneEvent.length, 0);

      // And because nothing was left behind, an immediate retry succeeds.
      const retry = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        { milestones: wholeAmountTerm() },
      );

      assert.equal(retry.ok, true);
      assert.equal(db.financialObligation.length, 1);
      assert.equal(db.milestone.length, 1);
    });
  });

  // -----------------------------------------------------------------------
  // Validation schema
  // -----------------------------------------------------------------------

  describe("funding validation schema", () => {
    it("accepts well-formed explicit terms", () => {
      const parsed = fundingValidation.prepareFundingSchema.safeParse({
        agreementId: "11111111-1111-4111-8111-111111111111",
        milestones: threeMilestoneTerms(),
      });

      assert.equal(parsed.success, true);
    });

    it("rejects a non-uuid agreement id", () => {
      const parsed = fundingValidation.prepareFundingSchema.safeParse({
        agreementId: "not-a-uuid",
        milestones: wholeAmountTerm(),
      });

      assert.equal(parsed.success, false);
    });

    it("rejects an empty milestone list", () => {
      const parsed = fundingValidation.prepareFundingSchema.safeParse({
        agreementId: "11111111-1111-4111-8111-111111111111",
        milestones: [],
      });

      assert.equal(parsed.success, false);
    });

    it("rejects negative and malformed amounts", () => {
      for (const creatorAmount of ["-100.00", "100.999", "1e5", "abc", ""]) {
        const parsed = fundingValidation.prepareFundingSchema.safeParse({
          agreementId: "11111111-1111-4111-8111-111111111111",
          milestones: [{ position: 1, creatorAmount }],
        });

        assert.equal(parsed.success, false, `expected rejection for ${creatorAmount}`);
      }
    });

    it("rejects more than 52 milestones", () => {
      const milestones = Array.from({ length: 53 }, (_, index) => ({
        position: index + 1,
        creatorAmount: "1.00",
      }));

      const parsed = fundingValidation.prepareFundingSchema.safeParse({
        agreementId: "11111111-1111-4111-8111-111111111111",
        milestones,
      });

      assert.equal(parsed.success, false);
    });
  });
});

// ---------------------------------------------------------------------------
// ADVERTISER FEE MODEL — the two mutually exclusive advertiser fee mechanisms,
// exercised at the PRODUCTION rates (5% / 5% / 7.5%) on a ₦100,000 agreement.
//   SINGLE_PAYMENT : 5% AGREEMENT_FUNDING charged upfront at funding.
//   MILESTONE      : NO funding fee; 5% MILESTONE_ADVERTISER_FEE collected per
//                    milestone at settlement, never out of escrow.
// The two 5% fees must NEVER both charge the advertiser on one amount.
// ---------------------------------------------------------------------------
describe("advertiser fee model — AGREEMENT_FUNDING vs MILESTONE_ADVERTISER_FEE", () => {
  const HUNDRED_THOUSAND = 10000000n; // ₦100,000 in kobo
  const MILESTONE = 2500000n; // ₦25,000 in kobo

  before(async () => {
    fundingService = await import("@/services/payments/funding.service");
  });

  beforeEach(() => {
    resetDb();
    addFeeConfigs();
    // Every scenario below asserts against the LIVE production basis points.
    useProductionRates();
  });

  /** Re-point the seeded rows at the live production basis points. */
  function useProductionRates(): void {
    const byType = (feeType: string) =>
      db.platformFeeConfig.find((c) => c.feeType === feeType) as Row | undefined;

    byType("AGREEMENT_FUNDING")!.feeBasisPoints = 500; // 5%
    byType("MILESTONE_ADVERTISER_FEE")!.feeBasisPoints = 500; // 5%
    byType("MILESTONE_CREATOR_FEE")!.feeBasisPoints = 750; // 7.5%
  }

  function fourMilestoneTerms() {
    return [1, 2, 3, 4].map((position) => ({
      position,
      title: `Stage ${position}`,
      creatorAmount: "25000.00",
    }));
  }

  describe("SINGLE_PAYMENT agreement (one milestone)", () => {
    it("advertiser pays ₦105,000, escrow holds ₦100,000, ₦5,000 funding revenue, no milestone fee", async () => {
      const agreement = addAgreement({ agreedAmount: "100000.00" });

      const result = await fundingService.prepareFundingForAgreement(agreement.id as string, ADV, {
        milestones: [{ position: 1, title: "Whole", creatorAmount: "100000.00" }],
      });

      assert.equal(result.ok, true);

      if (!result.ok) return;

      // The exact Paystack amount is this — provider verification compares
      // against it, so it is what the advertiser is actually charged.
      assert.equal(result.creatorAmountMinor, HUNDRED_THOUSAND);
      assert.equal(result.platformFeeMinor, 500000n); // 5% = ₦5,000
      assert.equal(result.advertiserTotalMinor, 10500000n); // ₦105,000
      assert.equal(result.currency, "NGN");
      assert.equal(result.milestones.length, 1);

      const milestone = db.milestone[0] as Row;

      // NO per-milestone advertiser fee — that would be the double charge.
      assert.equal(milestone.advertiserServiceFeeMinor, 0n);
      assert.equal(milestone.advertiserFeeConfigId, null);
      assert.equal(milestone.advertiserTotalMinor, HUNDRED_THOUSAND);
      // The creator commission is unchanged by this fee model.
      assert.equal(milestone.creatorCommissionMinor, 750000n); // 7.5% = ₦7,500
    });

    it("refuses a SINGLE-payment agreement with no ACTIVE funding fee configured", async () => {
      const agreement = addAgreement({ agreedAmount: "100000.00" });
      const funding = db.platformFeeConfig.find(
        (c) => c.feeType === "AGREEMENT_FUNDING",
      ) as Row;
      funding.status = "INACTIVE";

      const result = await fundingService.prepareFundingForAgreement(agreement.id as string, ADV, {
        milestones: [{ position: 1, creatorAmount: "100000.00" }],
      });

      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, "FEE_NOT_CONFIGURED");
      assert.equal(db.financialObligation.length, 0, "no obligation on refusal");
      assert.equal(db.milestone.length, 0, "no milestones on refusal");
    });
  });

  describe("MILESTONE agreement (four milestones)", () => {
    it("initial funding is exactly ₦100,000 with a ₦0 funding fee", async () => {
      useProductionRates();
      const agreement = addAgreement({ agreedAmount: "100000.00" });

      const result = await fundingService.prepareFundingForAgreement(agreement.id as string, ADV, {
        milestones: fourMilestoneTerms(),
      });

      assert.equal(result.ok, true);

      if (!result.ok) return;

      // The Paystack amount for initial multi-milestone funding is EXACTLY the
      // agreement amount — no 5% funding fee is included.
      assert.equal(result.creatorAmountMinor, HUNDRED_THOUSAND);
      assert.equal(result.platformFeeMinor, 0n);
      assert.equal(result.advertiserTotalMinor, HUNDRED_THOUSAND);
      assert.equal(result.milestones.length, 4);

      // Escrow is funded with exactly the creator's money: that value IS the
      // provider-verified advertiser total, so the escrow credit equals it.
      assert.equal(db.financialObligation[0].advertiserTotalMinor, HUNDRED_THOUSAND);
      assert.equal(db.financialObligation[0].feeConfigId, null);

      // Preparation moves no money.
      assert.equal(db.ledgerEntry.length, 0);
    });

    it("each ₦25,000 milestone freezes a ₦1,250 advertiser fee; four total ₦5,000", async () => {
      useProductionRates();
      const agreement = addAgreement({ agreedAmount: "100000.00" });

      await fundingService.prepareFundingForAgreement(agreement.id as string, ADV, {
        milestones: fourMilestoneTerms(),
      });

      assert.equal(db.milestone.length, 4);

      for (const milestone of db.milestone) {
        assert.equal(milestone.creatorAmountMinor, MILESTONE);
        assert.equal(milestone.advertiserServiceFeeMinor, 125000n); // 5% of ₦25,000
        assert.equal(milestone.creatorCommissionMinor, 187500n); // 7.5% of ₦25,000
        assert.notEqual(milestone.advertiserFeeConfigId, null);
      }

      const totalAdvertiserFee = db.milestone.reduce<bigint>(
        (sum, m) => sum + (m.advertiserServiceFeeMinor as bigint),
        0n,
      );

      assert.equal(totalAdvertiserFee, 500000n); // ₦5,000

      // Escrow is never over-funded: the fees are NOT part of the agreement
      // amount, so they must not be added to it.
      const milestoneSum = db.milestone.reduce<bigint>(
        (sum, m) => sum + (m.creatorAmountMinor as bigint),
        0n,
      );

      assert.equal(milestoneSum, HUNDRED_THOUSAND);
      assert.notEqual(
        HUNDRED_THOUSAND + totalAdvertiserFee,
        db.financialObligation[0].advertiserTotalMinor,
        "the milestone fee must never be folded into the funding amount",
      );
    });

    it("does NOT require an AGREEMENT_FUNDING config at all for a milestone agreement", async () => {
      useProductionRates();
      const agreement = addAgreement({ agreedAmount: "100000.00" });
      const funding = db.platformFeeConfig.find(
        (c) => c.feeType === "AGREEMENT_FUNDING",
      ) as Row;
      funding.status = "INACTIVE";

      const result = await fundingService.prepareFundingForAgreement(agreement.id as string, ADV, {
        milestones: fourMilestoneTerms(),
      });

      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.platformFeeMinor, 0n);
    });

    it("still refuses a milestone agreement with no ACTIVE milestone advertiser fee", async () => {
      useProductionRates();
      const agreement = addAgreement({ agreedAmount: "100000.00" });
      const fee = db.platformFeeConfig.find(
        (c) => c.feeType === "MILESTONE_ADVERTISER_FEE",
      ) as Row;
      fee.status = "INACTIVE";

      const result = await fundingService.prepareFundingForAgreement(agreement.id as string, ADV, {
        milestones: fourMilestoneTerms(),
      });

      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, "FEE_NOT_CONFIGURED");
      assert.equal(db.milestone.length, 0);
    });
  });

  describe("mutual exclusivity and idempotency", () => {
    it("a given agreement never collects both 5% fees", async () => {
      useProductionRates();

      // Single-payment: funding fee charged, milestone fee zero.
      const single = addAgreement({ agreedAmount: "100000.00" });
      const singleResult = await fundingService.prepareFundingForAgreement(
        single.id as string,
        ADV,
        { milestones: [{ position: 1, creatorAmount: "100000.00" }] },
      );
      assert.equal(singleResult.ok, true);
      if (singleResult.ok) {
        assert.equal(singleResult.platformFeeMinor, 500000n);
        assert.equal((db.milestone[0] as Row).advertiserServiceFeeMinor, 0n);
      }

      const singleTotalAdvertiserFee =
        (db.financialObligation[0].platformFeeMinor as bigint) +
        (db.milestone[0].advertiserServiceFeeMinor as bigint);

      assert.equal(singleTotalAdvertiserFee, 500000n, "exactly one 5% charged");

      db.campaignAgreement.length = 0;
      db.financialObligation.length = 0;
      db.milestone.length = 0;

      // Multi-milestone: funding fee zero, milestone fee collected instead.
      const multi = addAgreement({ agreedAmount: "100000.00" });
      const multiResult = await fundingService.prepareFundingForAgreement(
        multi.id as string,
        ADV,
        { milestones: fourMilestoneTerms() },
      );
      assert.equal(multiResult.ok, true);
      if (multiResult.ok) assert.equal(multiResult.platformFeeMinor, 0n);

      const multiTotalAdvertiserFee = db.milestone.reduce<bigint>(
        (sum, m) => sum + (m.advertiserServiceFeeMinor as bigint),
        0n,
      );

      assert.equal(
        (db.financialObligation[0].platformFeeMinor as bigint) + multiTotalAdvertiserFee,
        500000n,
        "exactly one 5% charged",
      );
    });

    it("re-preparing the same agreement is refused (no doubled fees)", async () => {
      useProductionRates();
      const agreement = addAgreement({ agreedAmount: "100000.00" });

      const first = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        { milestones: fourMilestoneTerms() },
      );
      assert.equal(first.ok, true);

      const second = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        { milestones: fourMilestoneTerms() },
      );

      assert.equal(second.ok, false);
      if (!second.ok) assert.equal(second.code, "ALREADY_PREPARED");
      assert.equal(db.financialObligation.length, 1);
      assert.equal(db.milestone.length, 4);
    });

    it("uses BigInt minor units end to end — no floats in any amount", async () => {
      useProductionRates();
      const agreement = addAgreement({ agreedAmount: "100000.00" });

      const result = await fundingService.prepareFundingForAgreement(
        agreement.id as string,
        ADV,
        { milestones: fourMilestoneTerms() },
      );

      assert.equal(result.ok, true);
      if (!result.ok) return;

      for (const value of [
        result.creatorAmountMinor,
        result.platformFeeMinor,
        result.advertiserTotalMinor,
      ]) {
        assert.equal(typeof value, "bigint");
      }

      for (const milestone of db.milestone) {
        for (const key of [
          "creatorAmountMinor",
          "advertiserServiceFeeMinor",
          "creatorCommissionMinor",
          "advertiserTotalMinor",
        ]) {
          assert.equal(typeof milestone[key], "bigint", `${key} must be bigint`);
        }
      }
    });
  });
});
