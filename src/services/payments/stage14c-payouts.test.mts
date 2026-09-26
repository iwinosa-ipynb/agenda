import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Stage 14C — creator payout tests (service layer, in-memory Prisma).
 *
 * Uses the established pattern: behavior-faithful stub with unique-constraint
 * simulation, conditional updates and per-transaction write tracking,
 * registered via mock.module BEFORE the modules under test are imported.
 *
 * Pins the audit matrix:
 *   - recipient: creator-only flow, idempotency, provider failure, name match;
 *   - payout: per-RELEASED-milestone, exact creator amount (fees excluded),
 *     logical payout vs per-attempt references, duplicate/concurrent
 *     initiation, dispute-before and dispute-race, provider reject,
 *     timeout-stays-pending, polling convergence, reversal compensating
 *     entries, webhook evidence handling, milestone independence;
 *   - the receivable-clearing ledger entry is written EXACTLY ONCE and never
 *     before provider-confirmed success.
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
  creatorPayout: [],
  creatorPayoutRecipient: [],
  milestone: [],
  webhookEvent: [],
};

let nextId = 1;
const id = (prefix: string) => `${prefix}-${nextId++}`;

function resetDb(): void {
  for (const table of Object.keys(db)) {
    db[table] = [];
  }

  nextId = 1;
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
    if (condition === null || condition === undefined) continue;

    if (typeof condition === "object" && !Array.isArray(condition)) {
      const operators = condition as Record<string, unknown>;

      if ("in" in operators && !(operators.in as unknown[]).includes(row[key])) return false;
      if ("not" in operators) {
        // Prisma "not" forms: { not: value }, { not: null } (IS NOT NULL),
        // and { not: { <filter> } } (nested filter — pass-through here).
        const raw = (operators as { not?: unknown }).not;
        const notValue =
          raw !== null && typeof raw === "object" && "not" in (raw as Record<string, unknown>)
            ? (raw as { not: unknown }).not
            : raw;

        if (notValue === null) {
          if (row[key] === null || row[key] === undefined) return false;

          continue;
        }

        if (typeof notValue === "object") {
          continue;
        }

        if (row[key] === notValue) return false;
      }

      continue;
    }

    if (row[key] !== condition) {
      return false;
    }
  }

  return true;
}

function applyData(row: Row, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      row[key] = value;
    }
  }
}

const prismaStub = {
  financialObligation: {
    findUnique: async (args: { where: { id?: string; agreementId?: string } }) => {
      const row = db.financialObligation.find(
        (o) =>
          (args.where.id === undefined || o.id === args.where.id) &&
          (args.where.agreementId === undefined || o.agreementId === args.where.agreementId),
      );

      return row ? structuredClone(row) : null;
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

      return structuredClone(row);
    },
    findMany: async () => structuredClone(db.financialEvent),
  },
  ledgerEntry: {
    create: async (args: { data: Record<string, unknown> }) => {
      const row = {
        ...args.data,
        id: typeof args.data.id === "string" ? args.data.id : id("ledger"),
      } as Row;

      enforceUnique("ledgerEntry", row, [["idempotencyKey"], ["id"]]);
      db.ledgerEntry.push(row);

      return structuredClone(row);
    },
    findMany: async () => structuredClone(db.ledgerEntry),
  },
  paymentProviderTransaction: {
    findUnique: async (args: { where: { provider_providerReference?: { provider: string; providerReference: string } } }) => {
      const compound = args.where.provider_providerReference;

      if (!compound) return null;

      const row = db.paymentProviderTransaction.find(
        (t) => t.provider === compound.provider && t.providerReference === compound.providerReference,
      );

      return row ? structuredClone(row) : null;
    },
    findFirst: async () => null,
    findMany: async (args: { where?: Record<string, unknown> }) => {
      const rows = db.paymentProviderTransaction.filter((t) =>
        args.where ? matches(t, args.where) : true,
      );

      return structuredClone(rows);
    },
    create: async (args: { data: Record<string, unknown> }) => {
      const row = {
        providerStatus: "PENDING",
        ...args.data,
        id: typeof args.data.id === "string" ? args.data.id : id("tx"),
      } as Row;

      enforceUnique("paymentProviderTransaction", row, [["provider", "providerReference"], ["id"]]);
      db.paymentProviderTransaction.push(row);

      return structuredClone(row);
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;

      for (const row of db.paymentProviderTransaction) {
        if (matches(row, args.where)) {
          applyData(row, args.data);
          count += 1;
        }
      }

      return { count };
    },
  },
  creatorPayout: {
    findUnique: async (args: { where: { id?: string; milestoneId?: string } }) => {
      const row = db.creatorPayout.find(
        (p) =>
          (args.where.id === undefined || p.id === args.where.id) &&
          (args.where.milestoneId === undefined || p.milestoneId === args.where.milestoneId),
      );

      return row ? structuredClone(row) : null;
    },
    create: async (args: { data: Record<string, unknown> }) => {
      const row = {
        status: "PENDING",
        attemptCount: 0,
        ...args.data,
        id: typeof args.data.id === "string" ? args.data.id : id("payout"),
      } as Row;

      enforceUnique("creatorPayout", row, [["milestoneId"], ["payoutRef"], ["id"]]);
      db.creatorPayout.push(row);

      return structuredClone(row);
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;

      for (const row of db.creatorPayout) {
        if (matches(row, args.where)) {
          applyData(row, args.data);
          count += 1;
        }
      }

      return { count };
    },
  },
  creatorPayoutRecipient: {
    findUnique: async (args: { where: { creatorId_provider_currency_status?: Record<string, string> } }) => {
      const compound = args.where.creatorId_provider_currency_status;

      if (!compound) return null;

      const row = db.creatorPayoutRecipient.find(
        (r) =>
          r.creatorId === compound.creatorId &&
          r.provider === compound.provider &&
          r.currency === compound.currency &&
          r.status === compound.status,
      );

      return row ? structuredClone(row) : null;
    },
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const row = db.creatorPayoutRecipient.find((r) => matches(r, args.where));

      return row ? structuredClone(row) : null;
    },
    create: async (args: { data: Record<string, unknown> }) => {
      const row = {
        status: "ACTIVE",
        ...args.data,
        id: typeof args.data.id === "string" ? args.data.id : id("recip"),
      } as Row;

      enforceUnique("creatorPayoutRecipient", row, [
        ["creatorId", "provider", "currency", "status"],
        ["id"],
      ]);
      db.creatorPayoutRecipient.push(row);

      return structuredClone(row);
    },
  },
  milestone: {
    findUnique: async (args: { where: { id: string } }) => {
      const row = db.milestone.find((m) => m.id === args.where.id);

      return row ? structuredClone(row) : null;
    },
    findMany: async (args: { where?: Record<string, unknown> }) => {
      const rows = db.milestone.filter((m) =>
        args.where ? matches(m, args.where) : true,
      );

      return structuredClone(rows);
    },
  },
  webhookEvent: {
    create: async (args: { data: Record<string, unknown> }) => {
      const row = {
        status: "RECEIVED",
        ...args.data,
        id: typeof args.data.id === "string" ? args.data.id : id("hook"),
      } as Row;

      if (row.providerEventId !== null) {
        enforceUnique("webhookEvent", row, [["provider", "providerEventId"]]);
      }

      enforceUnique("webhookEvent", row, [["id"]]);
      db.webhookEvent.push(row);

      return structuredClone(row);
    },
  },
  $transaction: async (input: unknown) => {
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
  },
} as unknown as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

function mockModule(specifier: string, exports: Record<string, unknown>): void {
  (mock.module as (spec: string, opts: Record<string, unknown>) => void)(
    specifier,
    { exports },
  );
}

mockModule("server-only", {});
mockModule("@/lib/prisma", { prisma: prismaStub as never });

type PayoutService = typeof import("@/services/payments/payout.service");
type RecipientService = typeof import("@/services/payments/payout-recipient.service");
type WebhookProcessing = typeof import("@/services/payments/webhook-processing.service");

let payoutService: PayoutService;
let recipientService: RecipientService;
let webhookProcessing: WebhookProcessing;
let paymentsPort: typeof import("@/services/payments/index");

const CREATOR = "creator-1";
const CREATOR_OTHER = "creator-other";

/** Wire a fake provider into the global port registry. */
function configureFakeProvider(provider: Record<string, unknown>): void {
  paymentsPort.resetPaymentProviderForTests();
  paymentsPort.configurePaymentProvider(provider as never);
}

function addMilestone(overrides: Record<string, unknown> = {}): Row {
  const row: Row = {
    id: id("mil"),
    milestoneRef: `MIL-${id("ref").toUpperCase()}`,
    status: "RELEASED",
    creatorId: CREATOR,
    creatorAmountMinor: 20000000n, // ₦200,000
    advertiserServiceFeeMinor: 1000000n,
    creatorCommissionMinor: 2000000n,
    advertiserTotalMinor: 21000000n,
    currency: "NGN",
    agreementId: id("agr"),
    position: 1,
    ...overrides,
  };

  db.milestone.push(row);

  return row;
}

function addObligation(overrides: Record<string, unknown> = {}): Row {
  const row: Row = {
    id: id("obligation"),
    agreementId: id("agr"),
    status: "RELEASED",
    escrowFunded: true,
    dispute: false,
    disputeReason: null,
    ...overrides,
  };

  db.financialObligation.push(row);

  return row;
}

function addActiveRecipient(overrides: Record<string, unknown> = {}): Row {
  const row: Row = {
    id: id("recip"),
    creatorId: CREATOR,
    provider: "paystack",
    currency: "NGN",
    recipientCode: "RCP_existing",
    accountName: "Test Creator",
    status: "ACTIVE",
    ...overrides,
  };

  db.creatorPayoutRecipient.push(row);

  return row;
}

/** Default payout test context: released milestone + funded obligation + recipient. */
function setupPayoutContext(overrides: { milestone?: Record<string, unknown>; obligation?: Record<string, unknown> } = {}) {
  const milestone = addMilestone(overrides.milestone);
  const obligation = addObligation({
    agreementId: milestone.agreementId,
    ...overrides.obligation,
  });

  addActiveRecipient();

  return { milestone, obligation };
}

function fakeTransferProvider(overrides: Partial<{
  createPayout: (request: { reference: string; amountMinor: bigint }) => Promise<{ status: string; providerReference: string | null; reason?: string }>;
  getTransferStatus: (request: { providerReference: string }) => Promise<{ status: string; providerReference: string }>;
  createRecipient: () => Promise<{ status: string; recipientCode?: string; reason?: string }>;
}> = {}) {
  return {
    name: "paystack",
    createCharge: async () => ({ status: "failed", providerReference: null, reason: "unused" }),
    verifyTransaction: async () => ({ status: "unverified", providerReference: null, reason: "unused" }),
    verifyWebhook: async () => ({ verified: false, reason: "unused" }),
    createRefund: async () => ({ status: "failed", providerReference: null, reason: "unused" }),
    getTransferStatus:
      overrides.getTransferStatus ??
      (async (request: { providerReference: string }) => ({
        status: "success",
        providerReference: request.providerReference,
      })),
    createPayout:
      overrides.createPayout ??
      (async (request: { reference: string }) => ({
        status: "pending",
        providerReference: `TRF_${request.reference.slice(-6)}`,
      })),
    createRecipient:
      overrides.createRecipient ??
      (async () => ({ status: "created", recipientCode: "RCP_new" })),
  };
}

describe("Stage 14C — creator payouts", () => {
  before(async () => {
    payoutService = await import("@/services/payments/payout.service");
    recipientService = await import("@/services/payments/payout-recipient.service");
    webhookProcessing = await import("@/services/payments/webhook-processing.service");
    paymentsPort = await import("@/services/payments/index");
  });

  beforeEach(() => {
    resetDb();
    paymentsPort.resetPaymentProviderForTests();
  });

  // -----------------------------------------------------------------------
  // Recipient
  // -----------------------------------------------------------------------

  describe("payout recipients", () => {
    it("creates a recipient server-side from bank details (never a client code)", async () => {
      configureFakeProvider(fakeTransferProvider());

      const result = await recipientService.savePayoutRecipient(CREATOR, {
        accountNumber: "0123456789",
        bankCode: "058",
        accountName: "Test Creator",
        currency: "NGN",
      });

      assert.equal(result.ok, true);

      if (result.ok) {
        assert.equal(result.recipientCode, "RCP_new");
        assert.equal(result.idempotentReplay, false);
      }

      assert.equal(db.creatorPayoutRecipient.length, 1);
      // The raw account number is NOT persisted.
      const stored = JSON.stringify(db.creatorPayoutRecipient[0]);

      assert.equal(stored.includes("0123456789"), false);
    });

    it("is idempotent: a second save returns the existing ACTIVE recipient", async () => {
      configureFakeProvider(fakeTransferProvider());

      const first = await recipientService.savePayoutRecipient(CREATOR, {
        accountNumber: "0123456789",
        bankCode: "058",
        accountName: "Test Creator",
        currency: "NGN",
      });

      const second = await recipientService.savePayoutRecipient(CREATOR, {
        accountNumber: "0123456789",
        bankCode: "058",
        accountName: "Test Creator",
        currency: "NGN",
      });

      assert.equal(first.ok, true);
      assert.equal(second.ok, true);

      if (second.ok) {
        assert.equal(second.idempotentReplay, true);
        assert.equal(second.recipientId, first.ok ? first.recipientId : "");
      }

      assert.equal(db.creatorPayoutRecipient.length, 1);
    });

    it("provider recipient failure is explicit and stores nothing", async () => {
      configureFakeProvider(
        fakeTransferProvider({
          createRecipient: async () => ({ status: "failed", reason: "Paystack rejected the recipient: name mismatch" }),
        }),
      );

      const result = await recipientService.savePayoutRecipient(CREATOR, {
        accountNumber: "0123456789",
        bankCode: "058",
        accountName: "Someone Else",
        currency: "NGN",
      });

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "RECIPIENT_FAILED");
        assert.match(result.reason, /name mismatch/);
      }

      assert.equal(db.creatorPayoutRecipient.length, 0);
    });

    it("an unconfigured provider refuses recipient creation (fail closed)", async () => {
      const result = await recipientService.savePayoutRecipient(CREATOR, {
        accountNumber: "0123456789",
        bankCode: "058",
        accountName: "Test Creator",
        currency: "NGN",
      });

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "PROVIDER_UNCONFIGURED");
      }
    });

    it("the recipient lookup is strictly creator-scoped", async () => {
      addActiveRecipient({ creatorId: CREATOR_OTHER, recipientCode: "RCP_other" });

      const found = await recipientService.getActiveRecipientForCreator(CREATOR, "NGN");

      assert.equal(found, null);
    });
  });

  // -----------------------------------------------------------------------
  // Payout initiation
  // -----------------------------------------------------------------------

  describe("payout initiation", () => {
    it("pays a RELEASED milestone exactly its frozen creator amount (fees excluded)", async () => {
      const { milestone } = setupPayoutContext();

      configureFakeProvider(fakeTransferProvider());

      const result = await payoutService.initiateMilestonePayout(milestone.id as string);

      assert.equal(result.ok, true);

      if (result.ok) {
        assert.equal(result.status, "PENDING"); // NOT paid — async transfer
        assert.equal(result.idempotentReplay, false);
        assert.match(result.attemptReference, /^mpo-.*:a1$/);
      }

      const attempt = db.paymentProviderTransaction[0];

      // ₦200,000 creator amount — never 21000000 (advertiser total), never fee-inclusive.
      assert.equal(attempt.amountMinor, 20000000n);
      assert.equal(attempt.milestoneId, milestone.id);
      assert.equal(attempt.providerStatus, "PENDING");

      // No receivable clearing before provider confirmation.
      assert.equal(db.ledgerEntry.length, 0);
      // The logical payout exists, one per milestone, with a deterministic ref.
      assert.equal(db.creatorPayout.length, 1);
      assert.equal(db.creatorPayout[0].payoutRef, `mpo-${milestone.id}`);
      assert.equal(db.creatorPayout[0].status, "PROCESSING");
      assert.equal(db.creatorPayout[0].attemptCount, 1);
    });

    it("a non-RELEASED milestone is refused", async () => {
      const { milestone } = setupPayoutContext({
        milestone: { status: "VERIFIED_PENDING_REVIEW" },
      });

      configureFakeProvider(fakeTransferProvider());

      const result = await payoutService.initiateMilestonePayout(milestone.id as string);

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "NOT_RELEASED");
      }

      assert.equal(db.paymentProviderTransaction.length, 0);
    });

    it("an unfunded or disputed obligation blocks the payout", async () => {
      const unfunded = setupPayoutContext({ obligation: { escrowFunded: false } });

      configureFakeProvider(fakeTransferProvider());

      const result1 = await payoutService.initiateMilestonePayout(unfunded.milestone.id as string);

      assert.equal(result1.ok, false);

      if (!result1.ok) {
        assert.equal(result1.code, "FUNDING_MISSING");
      }

      const disputed = setupPayoutContext({ obligation: { dispute: true } });

      const result2 = await payoutService.initiateMilestonePayout(disputed.milestone.id as string);

      assert.equal(result2.ok, false);

      if (!result2.ok) {
        assert.equal(result2.code, "DISPUTE_FROZEN");
      }

      assert.equal(db.paymentProviderTransaction.length, 0);
    });

    it("a missing recipient blocks the payout without calling the provider", async () => {
      const { milestone } = setupPayoutContext();

      // Remove the recipient.
      db.creatorPayoutRecipient.length = 0;

      let providerCalled = false;

      configureFakeProvider(
        fakeTransferProvider({
          createPayout: async (request) => {
            providerCalled = true;

            return { status: "pending", providerReference: request.reference };
          },
        }),
      );

      const result = await payoutService.initiateMilestonePayout(milestone.id as string);

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "RECIPIENT_MISSING");
      }

      assert.equal(providerCalled, false);
      assert.equal(db.paymentProviderTransaction.length, 0);
    });

    it("duplicate initiation reuses the in-flight attempt (provider called once)", async () => {
      const { milestone } = setupPayoutContext();

      let calls = 0;

      configureFakeProvider(
        fakeTransferProvider({
          createPayout: async (request) => {
            calls += 1;

            return { status: "pending", providerReference: `TRF_${request.reference.slice(-6)}` };
          },
        }),
      );

      const first = await payoutService.initiateMilestonePayout(milestone.id as string);

      assert.equal(first.ok, true);

      const second = await payoutService.initiateMilestonePayout(milestone.id as string);

      assert.equal(second.ok, true);

      if (second.ok) {
        assert.equal(second.idempotentReplay, true);
        assert.equal(second.attemptReference, first.ok ? first.attemptReference : "");
      }

      assert.equal(calls, 1);
      assert.equal(db.paymentProviderTransaction.length, 1);
      assert.equal(db.creatorPayout[0].attemptCount, 1);
    });

    it("each new attempt after a definitive failure gets a NEW provider reference", async () => {
      const { milestone } = setupPayoutContext();

      let calls = 0;

      configureFakeProvider(
        fakeTransferProvider({
          createPayout: async (request) => {
            calls += 1;

            if (calls === 1) {
              return { status: "failed", providerReference: null, reason: "insufficient balance" };
            }

            return { status: "pending", providerReference: `TRF_${request.reference.slice(-6)}_r2` };
          },
        }),
      );

      const first = await payoutService.initiateMilestonePayout(milestone.id as string);

      assert.equal(first.ok, false);
      assert.equal(db.creatorPayout[0].status, "FAILED");
      assert.equal(db.paymentProviderTransaction[0].providerStatus, "FAILED");
      // Milestone stays RELEASED; receivable untouched.
      assert.equal(db.milestone[0].status, "RELEASED");
      assert.equal(db.ledgerEntry.length, 0);

      const second = await payoutService.initiateMilestonePayout(milestone.id as string);

      assert.equal(second.ok, true);

      if (second.ok) {
        assert.equal(second.attemptCount, 2);
        assert.match(second.attemptReference, /:a2$/);
      }

      // Two attempts, two distinct references — never reused.
      assert.equal(calls, 2);
      assert.equal(db.paymentProviderTransaction.length, 2);
      assert.notEqual(
        db.paymentProviderTransaction[0].providerReference,
        db.paymentProviderTransaction[1].providerReference,
      );
    });

    it("concurrent initiation: exactly one provider call, the loser converges", async () => {
      const { milestone } = setupPayoutContext();

      let calls = 0;

      configureFakeProvider(
        fakeTransferProvider({
          createPayout: async (request) => {
            calls += 1;

            return { status: "pending", providerReference: `TRF_${request.reference.slice(-6)}` };
          },
        }),
      );

      const [a, b] = await Promise.all([
        payoutService.initiateMilestonePayout(milestone.id as string),
        payoutService.initiateMilestonePayout(milestone.id as string),
      ]);

      const winners = [a, b].filter((r) => r.ok && !r.idempotentReplay);
      const converged = [a, b].filter((r) => r.ok && r.idempotentReplay);

      assert.equal(winners.length, 1);
      assert.equal(converged.length, 1);
      assert.equal(calls, 1);
      assert.equal(db.paymentProviderTransaction.length, 1);
    });
  });

  // -----------------------------------------------------------------------
  // Evidence-driven settlement
  // -----------------------------------------------------------------------

  describe("provider-evidence settlement", () => {
    it("confirmed success clears the receivable EXACTLY ONCE with payout_completed", async () => {
      const { milestone } = setupPayoutContext();

      configureFakeProvider(fakeTransferProvider());

      await payoutService.initiateMilestonePayout(milestone.id as string);

      const reference = db.paymentProviderTransaction[0].providerReference as string;

      const first = await payoutService.settlePayoutFromProviderEvidence(reference, "success");

      assert.equal(first.ok, true);
      assert.match(first.note, /cleared/);

      // Exactly-once clearing entries (two lines: receivable DEBIT + settlement CREDIT).
      assert.equal(db.ledgerEntry.length, 2);
      assert.equal(db.ledgerEntry.find((e) => e.idempotencyKey === `mpaid:${reference}`)?.direction, "DEBIT");
      assert.equal(db.ledgerEntry.find((e) => e.idempotencyKey === `mpaid:${reference}`)?.account, `creator:${CREATOR}:receivable`);
      assert.equal(db.ledgerEntry.find((e) => e.idempotencyKey === `mpaid:${reference}:settlement`)?.direction, "CREDIT");

      assert.equal(db.creatorPayout[0].status, "PAID");
      assert.equal(db.paymentProviderTransaction[0].providerStatus, "SUCCEEDED");
      assert.equal(db.financialEvent.find((e) => e.eventType === "payout_completed")?.idempotencyKey, `evt:${reference}:payout_completed`);

      // Replay: no new ledger rows, no new events.
      const replay = await payoutService.settlePayoutFromProviderEvidence(reference, "success");

      assert.equal(replay.ok, true);
      assert.match(replay.note, /already settled/i);
      assert.equal(db.ledgerEntry.length, 2);
      assert.equal(db.financialEvent.filter((e) => e.eventType === "payout_completed").length, 1);

      // Milestone/obligation states were NEVER touched by payout execution.
      assert.equal(db.milestone[0].status, "RELEASED");
    });

    it("a definitive failure keeps the receivable open and the milestone untouched", async () => {
      const { milestone } = setupPayoutContext();

      configureFakeProvider(fakeTransferProvider());

      await payoutService.initiateMilestonePayout(milestone.id as string);

      const reference = db.paymentProviderTransaction[0].providerReference as string;

      const result = await payoutService.settlePayoutFromProviderEvidence(reference, "failed");

      assert.equal(result.ok, true);

      assert.equal(db.paymentProviderTransaction[0].providerStatus, "FAILED");
      assert.equal(db.creatorPayout[0].status, "FAILED");
      assert.equal(db.ledgerEntry.length, 0); // receivable NOT cleared
      assert.equal(db.milestone[0].status, "RELEASED");
      assert.equal(db.financialEvent.find((e) => e.eventType === "payout_failed")?.idempotencyKey, `evt:${reference}:payout_failed`);
    });

    it("a reversed transfer writes append-only compensating entries and re-opens the receivable", async () => {
      const { milestone } = setupPayoutContext();

      configureFakeProvider(fakeTransferProvider());

      await payoutService.initiateMilestonePayout(milestone.id as string);

      const reference = db.paymentProviderTransaction[0].providerReference as string;

      // Success first…
      await payoutService.settlePayoutFromProviderEvidence(reference, "success");

      assert.equal(db.ledgerEntry.length, 2);

      // …then the provider reverses it.
      const reversal = await payoutService.settlePayoutFromProviderEvidence(reference, "reversed");

      assert.equal(reversal.ok, true);

      // Compensating entries appended — history never rewritten.
      assert.equal(db.ledgerEntry.length, 4);
      assert.equal(db.ledgerEntry.find((e) => e.idempotencyKey === `mrev:${reference}:receivable`)?.direction, "CREDIT");
      assert.equal(db.ledgerEntry.find((e) => e.idempotencyKey === `mrev:${reference}:settlement`)?.direction, "DEBIT");

      assert.equal(db.paymentProviderTransaction[0].providerStatus, "REVERSED");
      assert.equal(db.creatorPayout[0].status, "REVERSAL_RECEIVED");
      assert.equal(db.financialEvent.find((e) => e.eventType === "payout_reversed")?.idempotencyKey, `evt:${reference}:payout_reversed`);
      assert.equal(db.milestone[0].status, "RELEASED");
    });

    it("an unknown provider reference mutates nothing", async () => {
      const result = await payoutService.settlePayoutFromProviderEvidence("mpo-nowhere:a9", "success");

      assert.equal(result.ok, false);
      assert.match(result.note, /No payout attempt matches/);
      assert.equal(db.ledgerEntry.length, 0);
      assert.equal(db.financialEvent.length, 0);
    });

    it("an attempt whose amount drifts from the frozen milestone amount is refused", async () => {
      const { milestone } = setupPayoutContext();

      configureFakeProvider(fakeTransferProvider());

      await payoutService.initiateMilestonePayout(milestone.id as string);

      // Tamper with the attempt amount.
      db.paymentProviderTransaction[0].amountMinor = 999n;

      const reference = db.paymentProviderTransaction[0].providerReference as string;

      const result = await payoutService.settlePayoutFromProviderEvidence(reference, "success");

      assert.equal(result.ok, false);
      assert.match(result.note, /does not match/);
      assert.equal(db.ledgerEntry.length, 0);
    });
  });

  // -----------------------------------------------------------------------
  // Dispute races
  // -----------------------------------------------------------------------

  describe("dispute handling", () => {
    it("a dispute engaging between initiation and the provider call blocks the transfer", async () => {
      const { milestone, obligation } = setupPayoutContext();

      let providerCalls = 0;

      configureFakeProvider(
        fakeTransferProvider({
          createPayout: async () => {
            providerCalls += 1;

            return { status: "pending", providerReference: "TRF_race" };
          },
        }),
      );

      // Simulate the freeze engaging between the initiation gates and the
      // claim transaction by flipping it from inside the claim window: the
      // stub's $transaction runs the callback synchronously, so flip it right
      // before the call and let the claim's fresh re-read observe it.
      const original = prismaStub.$transaction as unknown as (input: unknown) => Promise<unknown>;

      (prismaStub as Record<string, unknown>).$transaction = async (input: unknown) => {
        if (typeof input === "function") {
          // Flip the dispute just before the claim transaction reads it.
          obligation.dispute = true;
        }

        return original(input);
      };

      try {
        const result = await payoutService.initiateMilestonePayout(milestone.id as string);

        assert.equal(result.ok, false);

        if (!result.ok) {
          assert.equal(result.code, "DISPUTE_FROZEN");
        }

        assert.equal(providerCalls, 0);
        assert.equal(db.paymentProviderTransaction.length, 0);
      } finally {
        (prismaStub as Record<string, unknown>).$transaction = original;
        obligation.dispute = false;
      }
    });

    it("a dispute AFTER provider acceptance does not cancel the transfer — provider evidence decides", async () => {
      const { milestone, obligation } = setupPayoutContext();

      configureFakeProvider(fakeTransferProvider());

      await payoutService.initiateMilestonePayout(milestone.id as string);

      // Dispute engages after the transfer was accepted.
      obligation.dispute = true;

      const reference = db.paymentProviderTransaction[0].providerReference as string;

      // The provider still reports success — the payout settles on evidence.
      const result = await payoutService.settlePayoutFromProviderEvidence(reference, "success");

      assert.equal(result.ok, true);
      assert.equal(db.creatorPayout[0].status, "PAID");
      assert.equal(db.ledgerEntry.length, 2);
    });
  });

  // -----------------------------------------------------------------------
  // Webhook + polling
  // -----------------------------------------------------------------------

  describe("transfer webhooks and polling", () => {
    it("a transfer.success webhook settles the payout; duplicates are idempotent", async () => {
      const { milestone } = setupPayoutContext();

      configureFakeProvider(fakeTransferProvider());

      await payoutService.initiateMilestonePayout(milestone.id as string);

      const reference = db.paymentProviderTransaction[0].providerReference as string;

      const first = await webhookProcessing.processWebhookEvent(
        "hook-1",
        { event: "transfer.success", data: { reference } },
        "transfer.success",
      );

      assert.equal(first.processed, true);
      assert.match(first.note, /cleared|already/i);
      assert.equal(db.creatorPayout[0].status, "PAID");

      const second = await webhookProcessing.processWebhookEvent(
        "hook-1",
        { event: "transfer.success", data: { reference } },
        "transfer.success",
      );

      assert.equal(second.processed, true);
      assert.equal(db.ledgerEntry.length, 2); // unchanged
    });

    it("an unknown transfer reference in a webhook mutates nothing", async () => {
      const outcome = await webhookProcessing.processWebhookEvent(
        "hook-2",
        { event: "transfer.success", data: { reference: "mpo-unknown:a1" } },
        "transfer.success",
      );

      assert.equal(outcome.processed, true);
      assert.equal(db.ledgerEntry.length, 0);
    });

    it("an out-of-order transfer.reversed after nothing pending is handled without crashing", async () => {
      const outcome = await webhookProcessing.processWebhookEvent(
        "hook-3",
        { event: "transfer.reversed", data: { reference: "mpo-nowhere:a1" } },
        "transfer.reversed",
      );

      assert.equal(outcome.processed, true);
      assert.equal(db.ledgerEntry.length, 0);
    });

    it("polling converges a pending attempt to PAID exactly once", async () => {
      const { milestone } = setupPayoutContext();

      let pollCalls = 0;

      configureFakeProvider(
        fakeTransferProvider({
          getTransferStatus: async (request) => {
            pollCalls += 1;

            return { status: "success", providerReference: request.providerReference };
          },
        }),
      );

      await payoutService.initiateMilestonePayout(milestone.id as string);

      const first = await payoutService.pollPendingPayouts({
        providerOverride: {
          getTransferStatus: async (request) => {
            pollCalls += 1;

            return { status: "success", providerReference: request.providerReference };
          },
        },
        thresholdMinutes: -1, // include the fresh attempt
      });

      assert.equal(first.polled, 1);
      assert.equal(first.settled, 1);
      assert.equal(db.creatorPayout[0].status, "PAID");
      assert.equal(db.ledgerEntry.length, 2);

      const ledgerCount = db.ledgerEntry.length;

      // Second poll: nothing in flight anymore.
      const second = await payoutService.pollPendingPayouts({
        providerOverride: {
          getTransferStatus: async (request) => {
            pollCalls += 1;

            return { status: "success", providerReference: request.providerReference };
          },
        },
        thresholdMinutes: -1,
      });

      assert.equal(second.polled, 0);
      assert.equal(db.ledgerEntry.length, ledgerCount);
      assert.ok(pollCalls >= 1);
    });

    it("polling on provider timeout leaves the attempt pending (never auto-retry)", async () => {
      const { milestone } = setupPayoutContext();

      configureFakeProvider(fakeTransferProvider());

      await payoutService.initiateMilestonePayout(milestone.id as string);

      const result = await payoutService.pollPendingPayouts({
        providerOverride: {
          getTransferStatus: async () => ({ status: "unknown", providerReference: "x" }),
        },
        thresholdMinutes: -1,
      });

      assert.equal(result.polled, 1);
      assert.equal(result.settled, 0);
      assert.match(result.notes[0], /stays pending/);
      assert.equal(db.creatorPayout[0].status, "PROCESSING");
      assert.equal(db.paymentProviderTransaction[0].providerStatus, "PENDING");
      assert.equal(db.paymentProviderTransaction.length, 1); // no second attempt
    });

    it("polling a failed transfer marks the attempt FAILED with a new reference on retry", async () => {
      const { milestone } = setupPayoutContext();

      configureFakeProvider(fakeTransferProvider());

      await payoutService.initiateMilestonePayout(milestone.id as string);

      const reference = db.paymentProviderTransaction[0].providerReference as string;

      await payoutService.pollPendingPayouts({
        providerOverride: {
          getTransferStatus: async () => ({ status: "failed", providerReference: reference }),
        },
        thresholdMinutes: -1,
      });

      assert.equal(db.paymentProviderTransaction[0].providerStatus, "FAILED");
      assert.equal(db.creatorPayout[0].status, "FAILED");

      // Retry → new attempt, new reference.
      configureFakeProvider(fakeTransferProvider());

      const retry = await payoutService.initiateMilestonePayout(milestone.id as string);

      assert.equal(retry.ok, true);

      if (retry.ok) {
        assert.equal(retry.attemptCount, 2);
        assert.notEqual(retry.attemptReference, reference);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Milestone independence & multi-milestone
  // -----------------------------------------------------------------------

  describe("milestone independence", () => {
    it("paying milestone 2 does not touch milestones 1 or 3", async () => {
      const sharedAgreement = id("agr");

      const m1 = addMilestone({ position: 1, status: "RELEASED", agreementId: sharedAgreement });
      const m2 = addMilestone({ position: 2, status: "RELEASED", agreementId: sharedAgreement });
      const m3 = addMilestone({ position: 3, status: "VERIFIED_PENDING_REVIEW", agreementId: sharedAgreement });

      addObligation({ agreementId: m1.agreementId });
      addActiveRecipient();

      configureFakeProvider(fakeTransferProvider());

      const result = await payoutService.initiateMilestonePayout(m2.id as string);

      assert.equal(result.ok, true);

      // m1 has its own logical payout available but untouched here; m3 is not
      // payable at all; m2's payout exists alone.
      assert.equal(db.creatorPayout.length, 1);
      assert.equal(db.creatorPayout[0].milestoneId, m2.id);
      assert.equal(db.milestone.find((m) => m.id === m1.id)?.status, "RELEASED");
      assert.equal(db.milestone.find((m) => m.id === m3.id)?.status, "VERIFIED_PENDING_REVIEW");
    });
  });
});
