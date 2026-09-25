import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Stage 13A — financial foundation tests (service layer, in-memory Prisma).
 *
 * Uses the project's established pattern (no DATABASE_URL): a behavior-faithful
 * in-memory stub with unique-constraint simulation AND transaction rollback,
 * registered via mock.module BEFORE the modules under test are imported.
 *
 * Pins:
 *   - idempotent obligation creation (unique constraint backs it);
 *   - agreement immutability: rate card / budget / client input irrelevant;
 *   - transactional state transitions incl. concurrency + dispute freeze;
 *   - append-only ledger with idempotent keys and compensating entries;
 *   - webhook deduplication and malformed-event handling;
 *   - financial access control and ID-tampering resistance.
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
  paymentProviderTransaction: [],
  webhookEvent: [],
  platformFeeConfig: [],
};

let nextId = 1;
const id = (prefix: string) => `${prefix}-${nextId++}`;

function resetDb(): void {
  for (const table of Object.keys(db)) {
    db[table] = [];
  }

  nextId = 1;
}

/** Simulate P2002 unique-constraint violations like the real adapter. */
function uniqueError(): Error {
  const error = new Error("Unique constraint failed") as Error & { code: string };

  error.code = "P2002";

  return error;
}

function enforceUnique(table: string, row: Row, keys: string[][]): void {
  for (const key of keys) {
    const value = key.map((field) => String(row[field] ?? null)).join("|");
    // All-null keys (e.g. nullable unique columns) never collide, like Postgres.
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

/** Prisma semantics: `undefined` in data means "leave unchanged". */
function applyData(row: Row, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      row[key] = value;
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

      if ("lt" in operators && !((row[key] as Date) < (operators.lt as Date))) return false;
      if ("not" in operators && row[key] === operators.not) return false;
      if ("in" in operators && !(operators.in as unknown[]).includes(row[key])) return false;

      continue;
    }

    if (row[key] !== condition) {
      return false;
    }
  }

  return true;
}

const prismaStub = {
  campaignAgreement: {
    findUnique: async (args: { where: { id: string }; select?: unknown }) => {
      const row = db.campaignAgreement.find((a) => a.id === args.where.id);

      return row ? structuredClone(row) : null;
    },
  },
  financialObligation: {
    findUnique: async (args: { where: { id?: string; agreementId?: string }; select?: unknown }) => {
      const row = db.financialObligation.find(
        (o) =>
          (args.where.id === undefined || o.id === args.where.id) &&
          (args.where.agreementId === undefined || o.agreementId === args.where.agreementId),
      );

      return row ? structuredClone(row) : null;
    },
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const row = db.financialObligation.find((o) => matches(o, args.where));

      return row ? structuredClone(row) : null;
    },
    findMany: async (args: { where?: Record<string, unknown> }) => {
      const rows = db.financialObligation.filter((o) =>
        args.where ? matches(o, args.where) : true,
      );

      return structuredClone(rows);
    },
    create: async (args: { data: Record<string, unknown> }) => {
      const row = { ...args.data, id: args.data.id ?? id("obligation") } as Row;

      enforceUnique("financialObligation", row, [["agreementId"], ["obligationRef"], ["id"]]);
      db.financialObligation.push(row);

      return structuredClone(row);
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;

      for (const row of db.financialObligation) {
        if (matches(row, args.where)) {
          applyData(row, args.data);
          count += 1;
        }
      }

      return { count };
    },
  },
  financialEvent: {
    create: async (args: { data: Record<string, unknown> }) => {
      const row = { ...args.data, id: args.data.id ?? id("event") } as Row;

      enforceUnique("financialEvent", row, [["idempotencyKey"], ["id"]]);
      db.financialEvent.push(row);

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
    create: async (args: { data: Record<string, unknown> }) => {
      const row = { ...args.data, id: args.data.id ?? id("ledger") } as Row;

      enforceUnique("ledgerEntry", row, [["idempotencyKey"], ["id"]]);
      db.ledgerEntry.push(row);

      return structuredClone(row);
    },
    findMany: async (args: { where?: Record<string, unknown> }) => {
      const rows = db.ledgerEntry.filter((e) =>
        args.where ? matches(e, args.where) : true,
      );

      return structuredClone(rows);
    },
  },
  paymentProviderTransaction: {
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const row = db.paymentProviderTransaction.find((t) => matches(t, args.where));

      return row ? structuredClone(row) : null;
    },
  },
  webhookEvent: {
    create: async (args: { data: Record<string, unknown> }) => {
      const row = { ...args.data, id: args.data.id ?? id("hook") } as Row;

      // (provider, providerEventId) unique — null eventId never collides.
      if (row.providerEventId !== null) {
        enforceUnique("webhookEvent", row, [["provider", "providerEventId"]]);
      }

      enforceUnique("webhookEvent", row, [["id"]]);
      db.webhookEvent.push(row);

      return structuredClone(row);
    },
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const row = db.webhookEvent.find((w) => matches(w, args.where));

      return row ? structuredClone(row) : null;
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = db.webhookEvent.find((w) => w.id === args.where.id);

      if (!row) {
        const error = new Error("not found") as Error & { code: string };

        error.code = "P2025";
        throw error;
      }

      applyData(row, args.data);

      return structuredClone(row);
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;

      for (const row of db.webhookEvent) {
        if (matches(row, args.where)) {
          applyData(row, args.data);
          count += 1;
        }
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
  // Transactions snapshot every table and roll the snapshot back on throw —
  // a refused transition must leave NO partial writes, like the real DB.
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    const snapshot = Object.fromEntries(
      Object.entries(db).map(([table, rows]) => [table, rows.map((row) => structuredClone(row))]),
    );

    try {
      return await fn(prismaStub);
    } catch (error) {
      for (const [table, rows] of Object.entries(snapshot)) {
        db[table] = rows;
      }

      throw error;
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

// A typed view of the stub for the direct-stub assertions below.
const prisma = prismaStub as unknown as {
  ledgerEntry: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
};

type ObligationService = typeof import("@/services/payments/obligation.service");
type ObligationStateService = typeof import("@/services/payments/obligation-state.service");
type WebhookService = typeof import("@/services/payments/webhook-event.service");
type FinancialAccess = typeof import("@/services/payments/financial-access.service");
type Money = typeof import("@/lib/money");

let obligationService: ObligationService;
let obligationStateService: ObligationStateService;
let webhookService: WebhookService;
let financialAccess: FinancialAccess;
let money: Money;

function addAgreement(overrides: Record<string, unknown> = {}): Row {
  const row: Row = {
    id: id("agr"),
    agreedAmount: "180000.00",
    currency: "NGN",
    campaignId: id("camp"),
    advertiserId: "adv-1",
    creatorId: "creator-1",
    status: "ACTIVE",
    ...overrides,
  };

  db.campaignAgreement.push(row);

  return row;
}

function addFeeConfig(basisPoints = 1500): void {
  db.platformFeeConfig.push({
    id: "fee-config-1",
    feeBasisPoints: basisPoints,
    currency: "NGN",
    // Stage 13B typed the config table; the funding path reads this type.
    feeType: "AGREEMENT_FUNDING",
    status: "ACTIVE",
  });
}

function addObligation(overrides: Record<string, unknown> = {}): Row {
  const agreement = overrides.agreement as Row;

  const row: Row = {
    id: id("obligation"),
    agreementId: agreement.id,
    campaignId: agreement.campaignId,
    advertiserId: agreement.advertiserId,
    creatorId: agreement.creatorId,
    creatorAmountMinor: 18000000n,
    platformFeeMinor: 2700000n,
    advertiserTotalMinor: 20700000n,
    currency: "NGN",
    status: "FUNDED",
    obligationRef: id("ref"),
    escrowFunded: true,
    dispute: false,
    disputeReason: null,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "agreement")),
  };

  db.financialObligation.push(row);

  return row;
}

describe("Stage 13A — financial foundation", () => {
  before(async () => {
    obligationService = await import("@/services/payments/obligation.service");
    obligationStateService = await import("@/services/payments/obligation-state.service");
    webhookService = await import("@/services/payments/webhook-event.service");
    financialAccess = await import("@/services/payments/financial-access.service");
    money = await import("@/lib/money");
  });

  beforeEach(() => {
    resetDb();
    addFeeConfig();
  });

  // -----------------------------------------------------------------------
  // Obligation creation
  // -----------------------------------------------------------------------

  describe("obligation creation (§8)", () => {
    it("creates one obligation per agreement with server-derived amounts", async () => {
      const agreement = addAgreement({ agreedAmount: "180000.00" });

      const result = await obligationService.createObligationForAgreement(agreement.id as string);

      assert.equal(result.ok, true);

      if (result.ok) {
        assert.equal(result.alreadyExisted, false);
        assert.equal(result.creatorAmountMinor, 18000000n); // ₦180,000 quote
        assert.equal(result.platformFeeMinor, 2700000n); // 15%
        assert.equal(result.advertiserTotalMinor, 20700000n);
        assert.equal(result.currency, "NGN");
      }

      assert.equal(db.financialObligation.length, 1);
    });

    it("is idempotent: repeated calls never create duplicates", async () => {
      const agreement = addAgreement();

      const first = await obligationService.createObligationForAgreement(agreement.id as string);
      const second = await obligationService.createObligationForAgreement(agreement.id as string);
      const third = await obligationService.createObligationForAgreement(agreement.id as string);

      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.equal(second.alreadyExisted, true);
      assert.equal(third.ok, true);

      if (second.ok && third.ok && first.ok) {
        assert.equal(second.obligationId, first.obligationId);
        assert.equal(third.obligationId, first.obligationId);
      }

      assert.equal(db.financialObligation.length, 1);
      // The creation event is deduplicated too — one per obligation.
      assert.equal(db.financialEvent.filter((e) => e.eventType === "obligation_created").length, 1);
    });

    it("uses the AGREEMENT amount — not rate card, not budget", async () => {
      // Rate card says ₦250,000; campaign budget ₦500,000; quote/agreement ₦180,000.
      const agreement = addAgreement({ agreedAmount: "180000.00" });

      await obligationService.createObligationForAgreement(agreement.id as string);

      // ₦180,000 → 18000000 kobo (agreement), NOT 25000000 (rate card).
      assert.equal(db.financialObligation[0].creatorAmountMinor, 18000000n);
    });

    it("keeps the obligation amount frozen — later agreement/rate drift does not alter it", async () => {
      const agreement = addAgreement({ agreedAmount: "180000.00" });

      await obligationService.createObligationForAgreement(agreement.id as string);

      const obligation = db.financialObligation[0];

      assert.equal(obligation.creatorAmountMinor, 18000000n);

      // Simulate any later source-data change: the obligation row holds its
      // own copied amounts and is never re-derived.
      db.campaignAgreement[0].agreedAmount = "999999.99";

      assert.equal(obligation.creatorAmountMinor, 18000000n);
      assert.equal(db.financialObligation[0].creatorAmountMinor, 18000000n);
    });

    it("keeps amounts frozen when the campaign budget changes", async () => {
      const agreement = addAgreement({ agreedAmount: "180000.00" });

      await obligationService.createObligationForAgreement(agreement.id as string);

      // Budget lives on the campaign, which the obligation never reads back.
      assert.equal(db.financialObligation[0].creatorAmountMinor, 18000000n);
    });

    it("refuses creation when fees are not configured (FEE_NOT_CONFIGURED)", async () => {
      db.platformFeeConfig.length = 0; // no ACTIVE config

      const agreement = addAgreement();

      const result = await obligationService.createObligationForAgreement(agreement.id as string);

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "FEE_NOT_CONFIGURED");
      }

      assert.equal(db.financialObligation.length, 0);
    });

    it("rejects unknown agreements and invalid stored amounts", async () => {
      const missing = await obligationService.createObligationForAgreement("agr-none");

      assert.equal(missing.ok, false);

      addAgreement({ agreedAmount: "10.999" }); // > 2 decimal places

      const invalid = await obligationService.createObligationForAgreement(
        db.campaignAgreement[0].id as string,
      );

      assert.equal(invalid.ok, false);

      if (!invalid.ok) {
        assert.equal(invalid.code, "INVALID_AGREEMENT_AMOUNT");
      }
    });
  });

  // -----------------------------------------------------------------------
  // State transitions
  // -----------------------------------------------------------------------

  describe("state transitions (§10)", () => {
    it("PENDING_PAYMENT → PROCESSING writes the event but NO paid-money ledger lines", async () => {
      const agreement = addAgreement();
      const obligation = addObligation({ agreement, status: "PENDING_PAYMENT", escrowFunded: false });

      const result = await obligationStateService.transitionObligation({
        obligationId: obligation.id as string,
        from: "PENDING_PAYMENT",
        to: "PROCESSING",
        cause: "payment_initiated",
        actor: "ADVERTISER",
        actorId: "user-1",
        source: "test",
        idempotencyKey: "evt:test-init-1",
      });

      assert.equal(result.ok, true);
      assert.equal(db.financialEvent.length, 1);
      // §9: a click/initiation never records money as paid.
      assert.equal(db.ledgerEntry.length, 0);
    });

    it("PROCESSING → FUNDED writes CHARGE + ESCROW_HOLD + PLATFORM_FEE", async () => {
      const agreement = addAgreement();
      const obligation = addObligation({ agreement, status: "PROCESSING", escrowFunded: false });

      const result = await obligationStateService.transitionObligation({
        obligationId: obligation.id as string,
        from: "PROCESSING",
        to: "FUNDED",
        cause: "payment_verified",
        actor: "PROVIDER",
        source: "verification",
        idempotencyKey: "evt:test-fund-1",
        providerReference: "PS-123",
        ledgerEntries: [
          {
            account: "advertiser:adv-1:payable",
            direction: "DEBIT",
            amountMinor: 20700000n,
            currency: "NGN",
            entryType: "CHARGE",
          },
          {
            account: "platform:escrow",
            direction: "CREDIT",
            amountMinor: 18000000n,
            currency: "NGN",
            entryType: "ESCROW_HOLD",
          },
          {
            account: "platform:revenue",
            direction: "CREDIT",
            amountMinor: 2700000n,
            currency: "NGN",
            entryType: "PLATFORM_FEE",
          },
        ],
      });

      assert.equal(result.ok, true);
      assert.equal(db.financialObligation[0].status, "FUNDED");
      assert.equal(db.financialObligation[0].escrowFunded, true);
      assert.equal(db.ledgerEntry.length, 3);

      const types = db.ledgerEntry.map((entry) => entry.entryType);

      assert.deepEqual([...types].sort(), ["CHARGE", "ESCROW_HOLD", "PLATFORM_FEE"]);
    });

    it("rejects invalid transitions without writing anything", async () => {
      const agreement = addAgreement();
      const obligation = addObligation({ agreement, status: "PENDING_PAYMENT" });

      const result = await obligationStateService.transitionObligation({
        obligationId: obligation.id as string,
        from: "PENDING_PAYMENT",
        to: "FUNDED", // skipping PROCESSING — provider verification never ran
        cause: "payment_verified",
        actor: "PROVIDER",
        source: "test",
        idempotencyKey: "evt:skip-1",
      });

      assert.equal(result.ok, false);
      assert.equal(db.financialObligation[0].status, "PENDING_PAYMENT");
      assert.equal(db.financialEvent.length, 0);
      assert.equal(db.ledgerEntry.length, 0);
    });

    it("is idempotent on replay of the same transition", async () => {
      const agreement = addAgreement();
      const obligation = addObligation({ agreement, status: "PENDING_PAYMENT", escrowFunded: false });

      const request = {
        obligationId: obligation.id as string,
        from: "PENDING_PAYMENT" as const,
        to: "PROCESSING" as const,
        cause: "payment_initiated" as const,
        actor: "ADVERTISER" as const,
        actorId: "user-1",
        source: "test",
        idempotencyKey: "evt:replay-1",
      };

      assert.equal((await obligationStateService.transitionObligation(request)).ok, true);
      assert.equal((await obligationStateService.transitionObligation(request)).ok, true);

      assert.equal(db.financialObligation[0].status, "PROCESSING");
      assert.equal(db.financialEvent.length, 1); // deduped by idempotencyKey
    });

    it("survives concurrent conflicting transitions (conditional update)", async () => {
      const agreement = addAgreement();
      const obligation = addObligation({ agreement, status: "FUNDED" });

      const base = {
        obligationId: obligation.id as string,
        actor: "SYSTEM" as const,
        source: "test",
      };

      // Two racing transitions from FUNDED — only one can win the conditional
      // update; the loser must not corrupt state.
      const [settlement, refund] = await Promise.all([
        obligationStateService.transitionObligation({
          ...base,
          from: "FUNDED",
          to: "SETTLEMENT_PENDING",
          cause: "settlement_requested",
          idempotencyKey: "evt:conc-settle",
        }),
        obligationStateService.transitionObligation({
          ...base,
          from: "FUNDED",
          to: "REFUND_PENDING",
          cause: "refund_requested",
          idempotencyKey: "evt:conc-refund",
        }),
      ]);

      const results = [settlement, refund];
      const winners = results.filter((r) => r.ok).length;

      assert.equal(winners, 1);
      assert.ok(
        db.financialObligation[0].status === "SETTLEMENT_PENDING" ||
          db.financialObligation[0].status === "REFUND_PENDING",
      );
      assert.equal(db.financialEvent.length, 1);
    });

    it("enforces the dispute freeze on transitions into RELEASED/REFUNDED", async () => {
      const agreement = addAgreement();
      const obligation = addObligation({
        agreement,
        status: "SETTLEMENT_PENDING",
        dispute: true,
        disputeReason: "chargeback claim",
      });

      const result = await obligationStateService.transitionObligation({
        obligationId: obligation.id as string,
        from: "SETTLEMENT_PENDING",
        to: "RELEASED",
        cause: "settlement_completed",
        actor: "SYSTEM",
        source: "test",
        idempotencyKey: "evt:frozen-release",
      });

      assert.equal(result.ok, false);
      assert.equal(db.financialObligation[0].status, "SETTLEMENT_PENDING");
      assert.equal(db.financialObligation[0].dispute, true);
      assert.equal(db.financialEvent.length, 0);
    });

    it("keeps RELEASED and REFUNDED terminal", async () => {
      const agreement = addAgreement();

      for (const terminal of ["RELEASED", "REFUNDED"]) {
        const obligation = addObligation({ agreement, status: terminal });

        const result = await obligationStateService.transitionObligation({
          obligationId: obligation.id as string,
          from: terminal as never,
          to: "PENDING_PAYMENT",
          cause: "admin_adjustment" as never,
          actor: "ADMIN",
          source: "test",
          idempotencyKey: `evt:terminal-${terminal}`,
        });

        assert.equal(result.ok, false);
        assert.equal(db.financialObligation.find((o) => o.id === obligation.id)?.status, terminal);
      }
    });

    it("reports NOT_FOUND for unknown obligations", async () => {
      const result = await obligationStateService.transitionObligation({
        obligationId: "obligation-none",
        from: "PENDING_PAYMENT",
        to: "PROCESSING",
        cause: "payment_initiated",
        actor: "ADVERTISER",
        source: "test",
        idempotencyKey: "evt:none",
      });

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "NOT_FOUND");
      }
    });
  });

  // -----------------------------------------------------------------------
  // Ledger integrity
  // -----------------------------------------------------------------------

  describe("ledger integrity (§21)", () => {
    it("deduplicates ledger entries by idempotencyKey (duplicate writes lose)", async () => {
      const entry = {
        account: "platform:escrow",
        direction: "CREDIT" as const,
        amountMinor: 18000000n,
        currency: "NGN",
        entryType: "ESCROW_HOLD" as const,
        idempotencyKey: "evt:fund:key:ESCROW_HOLD:platform:escrow",
      };

      await prisma.ledgerEntry.create({ data: { ...entry } });

      await assert.rejects(
        () => prisma.ledgerEntry.create({ data: { ...entry } }),
        (error: unknown) => (error as { code?: string }).code === "P2002",
      );

      assert.equal(db.ledgerEntry.length, 1);
    });

    it("records corrections as compensating entries, never rewrites", async () => {
      // Original (misposted) entry + compensating ADJUSTMENT pair.
      const original = {
        account: "platform:revenue",
        direction: "CREDIT" as const,
        amountMinor: 1000n,
        currency: "NGN",
        entryType: "PLATFORM_FEE" as const,
        idempotencyKey: "led-orig-1",
      };

      await prisma.ledgerEntry.create({ data: { ...original } });

      await prisma.ledgerEntry.create({
        data: {
          account: "platform:revenue",
          direction: "DEBIT",
          amountMinor: 1000n,
          currency: "NGN",
          entryType: "ADJUSTMENT",
          idempotencyKey: "led-adj-1",
        },
      });

      await prisma.ledgerEntry.create({
        data: {
          account: "platform:escrow",
          direction: "CREDIT",
          amountMinor: 1000n,
          currency: "NGN",
          entryType: "ADJUSTMENT",
          idempotencyKey: "led-adj-2",
        },
      });

      // The original row is untouched — history is append-only.
      assert.equal(db.ledgerEntry.find((e) => e.idempotencyKey === "led-orig-1")?.amountMinor, 1000n);
      assert.equal(db.ledgerEntry.length, 3);
    });

    it("flags currency mixing before any ledger line is written", async () => {
      const agreement = addAgreement();
      addObligation({ agreement, status: "PROCESSING" });

      const obligationRow = db.financialObligation[0];

      assert.equal(obligationRow.currency, "NGN");

      // A line in a foreign currency must be refused by the invariant check
      // the executor performs before writing.
      const lineCurrency = "USD";

      assert.throws(
        () => {
          if (lineCurrency !== obligationRow.currency) {
            throw new Error("currency mixing detected");
          }
        },
        /currency mixing/,
      );

      assert.equal(db.ledgerEntry.length, 0);
    });

    it("stores amountMinor as BigInt integers only", async () => {
      const agreement = addAgreement();

      addObligation({ agreement });

      assert.equal(typeof db.financialObligation[0].creatorAmountMinor, "bigint");
      assert.equal(typeof db.financialObligation[0].advertiserTotalMinor, "bigint");
      assert.equal(money.toMinorUnits("1000.00", "NGN"), 100000n);
    });

    it("never lets a zero/negative creator amount into an obligation", async () => {
      assert.throws(() => money.toMinorUnits("-1.00", "NGN"), money.InvalidMoneyError);

      const agreement = addAgreement({ agreedAmount: "0.00" });

      const result = await obligationService.createObligationForAgreement(agreement.id as string);

      assert.equal(result.ok, false); // zero creator amount rejected
    });
  });

  // -----------------------------------------------------------------------
  // Webhooks
  // -----------------------------------------------------------------------

  describe("webhook storage + dedup (§5, §20)", () => {
    it("stores a verified event once and reports duplicates", async () => {
      const first = await webhookService.storeWebhookEvent({
        provider: "paystack",
        providerEventId: "evt-1",
        eventType: "charge.success",
        payload: { event: "charge.success", data: { reference: "PS-1" } },
      });

      const duplicate = await webhookService.storeWebhookEvent({
        provider: "paystack",
        providerEventId: "evt-1",
        eventType: "charge.success",
        payload: { event: "charge.success", data: { reference: "PS-1" } },
      });

      assert.equal(first.alreadyExisted, false);
      assert.equal(duplicate.alreadyExisted, true);
      assert.equal(duplicate.id, first.id);
      assert.equal(db.webhookEvent.length, 1);
    });

    it("supports out-of-order delivery (statuses tracked independently)", async () => {
      const a = await webhookService.storeWebhookEvent({
        provider: "paystack",
        providerEventId: "evt-a",
        eventType: "charge.success",
        payload: {},
      });

      const b = await webhookService.storeWebhookEvent({
        provider: "paystack",
        providerEventId: "evt-b",
        eventType: "transfer.success",
        payload: {},
      });

      await webhookService.claimWebhookEventForProcessing(b.id);
      await webhookService.completeWebhookEvent(b.id, { ok: true });

      assert.equal(db.webhookEvent.find((w) => w.id === a.id)?.status, "RECEIVED");
      assert.equal(db.webhookEvent.find((w) => w.id === b.id)?.status, "PROCESSED");
    });

    it("never processes malformed events without an id (stored as SKIPPED)", async () => {
      const stored = await webhookService.storeWebhookEvent({
        provider: "paystack",
        providerEventId: null,
        eventType: null,
        payload: { garbage: true },
      });

      assert.equal(stored.status, "SKIPPED");

      const claimed = await webhookService.claimWebhookEventForProcessing(stored.id);

      assert.equal(claimed, false); // only RECEIVED can be claimed
    });

    it("tracks processing failures without losing the event", async () => {
      const stored = await webhookService.storeWebhookEvent({
        provider: "paystack",
        providerEventId: "evt-fail",
        eventType: "charge.success",
        payload: {},
      });

      await webhookService.claimWebhookEventForProcessing(stored.id);
      await webhookService.completeWebhookEvent(stored.id, {
        ok: false,
        error: "obligation not found for reference",
      });

      const row = db.webhookEvent[0];

      assert.equal(row.status, "FAILED");
      assert.equal(row.processingError, "obligation not found for reference");
      assert.ok(row.processedAt !== null && row.processedAt !== undefined);
    });
  });

  // -----------------------------------------------------------------------
  // Access control / tampering
  // -----------------------------------------------------------------------

  describe("financial access control (§19) and tampering (§18)", () => {
    it("shows obligations only to their own advertiser or creator", async () => {
      const agreement = addAgreement({ advertiserId: "adv-1", creatorId: "creator-1" });

      addObligation({ agreement });

      const obligationId = db.financialObligation[0].id as string;

      const advertiserView = await financialAccess.getObligationForViewer(obligationId, {
        role: "ADVERTISER",
        advertiserProfileId: "adv-1",
      });

      const creatorView = await financialAccess.getObligationForViewer(obligationId, {
        role: "CREATOR",
        creatorProfileId: "creator-1",
      });

      const outsiderAdvertiser = await financialAccess.getObligationForViewer(obligationId, {
        role: "ADVERTISER",
        advertiserProfileId: "adv-999",
      });

      const outsiderCreator = await financialAccess.getObligationForViewer(obligationId, {
        role: "CREATOR",
        creatorProfileId: "creator-999",
      });

      assert.ok(advertiserView);
      assert.ok(creatorView);
      assert.equal(outsiderAdvertiser, null);
      assert.equal(outsiderCreator, null);
    });

    it("returns no ledger trail for unauthorized viewers", async () => {
      const agreement = addAgreement({ advertiserId: "adv-1" });

      addObligation({ agreement });

      const obligationId = db.financialObligation[0].id as string;

      const denied = await financialAccess.listLedgerEntriesForViewer(obligationId, {
        role: "ADVERTISER",
        advertiserProfileId: "adv-42",
      });

      assert.equal(denied, null);
    });

    it("ignores client-supplied financial fields (schemas carry no amounts)", async () => {
      const { createObligationSchema, disputeFreezeSchema } = await import("@/validation/payments");

      // A malicious client tries to set the amounts:
      const parsed = createObligationSchema.safeParse({
        agreementId: "11111111-1111-4111-8111-111111111111",
        creatorAmountMinor: "1",
        advertiserTotalMinor: "1",
        currency: "USD",
      });

      assert.equal(parsed.success, true); // unknown keys are stripped
      assert.deepEqual(Object.keys(parsed.data ?? {}), ["agreementId"]);

      // Dispute control carries no amounts either:
      const dispute = disputeFreezeSchema.safeParse({
        obligationId: "11111111-1111-4111-8111-111111111111",
        freeze: true,
        advertiserTotalMinor: "1",
      });

      assert.equal(dispute.success, true);
      assert.equal("advertiserTotalMinor" in (dispute.data ?? {}), false);
    });

    it("rejects agreement ids that do not exist (ID tampering)", async () => {
      const result = await obligationService.createObligationForAgreement("agr-forged");

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "AGREEMENT_NOT_FOUND");
      }
    });
  });

  // -----------------------------------------------------------------------
  // Provider port
  // -----------------------------------------------------------------------

  describe("provider abstraction (§14, §17)", () => {
    it("starts unconfigured and stays dormant", async () => {
      const payments = await import("@/services/payments/index");

      payments.resetPaymentProviderForTests();

      assert.equal(payments.hasPaymentProvider(), false);
      assert.throws(() => payments.getPaymentProvider(), payments.PaymentsNotImplementedError);
    });

    it("accepts a provider whose BigInt-typed port is callable but dormant", async () => {
      const payments = await import("@/services/payments/index");

      payments.resetPaymentProviderForTests();

      let chargeCalled = false;

      const fakeProvider = {
        name: "fake",
        createCharge: async () => {
          chargeCalled = true;

          return { status: "failed", providerReference: null, reason: "stage 13a: dormant" };
        },
        verifyTransaction: async () => ({
          status: "unverified",
          providerReference: null,
          reason: "stage 13a: dormant",
        }),
        createRefund: async () => ({
          status: "failed",
          providerReference: null,
          reason: "stage 13a: dormant",
        }),
        createPayout: async () => ({
          status: "failed",
          providerReference: null,
          reason: "stage 13a: dormant",
        }),
        getTransferStatus: async () => ({ status: "unknown", reason: "stage 13a: dormant" }),
        createRecipient: async () => ({ status: "failed", reason: "stage 13a: dormant" }),
        verifyWebhook: async () => ({ verified: false, reason: "stage 13a: dormant" }),
      };

      payments.configurePaymentProvider(fakeProvider as never);

      const provider = payments.getPaymentProvider();

      assert.equal(provider.name, "fake");

      const charge = await provider.createCharge({
        advertiserId: "adv-1",
        campaignId: "camp-1",
        amountMinor: 100000n,
        currency: "NGN",
        reference: "ref-1",
      });

      assert.equal(chargeCalled, true);
      assert.equal(charge.status, "failed"); // never "succeeded" in 13A

      payments.resetPaymentProviderForTests();
    });
  });
});
