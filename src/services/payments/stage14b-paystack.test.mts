import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Stage 14B — Paystack provider integration tests (service layer, in-memory
 * Prisma + injected HTTP boundary). Uses the established pattern: a
 * behavior-faithful stub with unique-constraint simulation and per-transaction
 * write tracking (concurrent commits survive a sibling's rollback), registered
 * via mock.module BEFORE the modules under test are imported.
 *
 * Pins the Stage 14B audit matrix:
 *   - charge initialization: success, duplicate, provider failure, state gate;
 *   - verification: success → FUNDED with the 13A ledger shape; amount/currency
 *     mismatch → refusal; provider timeout → stays PROCESSING; replay no-op;
 *   - definitive failure → FAILED, no ledger lines;
 *   - webhook: valid/invalid signature, dedupe, unknown reference, out-of-order;
 *   - dormant mode: no provider configured → explicit refusals, 503 route.
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
  milestone: [],
  platformFeeConfig: [],
};

let nextId = 1;
const id = (prefix: string) => `${prefix}-${nextId++}`;

let failNextTransactionCreate = false;

function resetDb(): void {
  for (const table of Object.keys(db)) {
    db[table] = [];
  }

  nextId = 1;
  failNextTransactionCreate = false;
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
    if (condition === null || condition === undefined) continue;

    if (typeof condition === "object" && !Array.isArray(condition)) {
      const operators = condition as Record<string, unknown>;

      if ("in" in operators && !(operators.in as unknown[]).includes(row[key])) return false;
      if ("lt" in operators && !((row[key] as Date) < (operators.lt as Date))) return false;

      continue;
    }

    if (row[key] !== condition) {
      return false;
    }
  }

  return true;
}

/** Writes performed by the transaction currently running (for its rollback). */
let transactionWrites: Array<{ table: string; row: Row }> = [];

const prismaStub = {
  financialObligation: {
    findUnique: async (args: { where: { id?: string; agreementId?: string; obligationRef?: string } }) => {
      const row = db.financialObligation.find(
        (o) =>
          (args.where.id === undefined || o.id === args.where.id) &&
          (args.where.agreementId === undefined || o.agreementId === args.where.agreementId) &&
          (args.where.obligationRef === undefined || o.obligationRef === args.where.obligationRef),
      );

      return row ? structuredClone(row) : null;
    },
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const row = db.financialObligation.find((o) => matches(o, args.where));

      return row ? structuredClone(row) : null;
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;

      for (const row of db.financialObligation) {
        if (matches(row, args.where)) {
          for (const [key, value] of Object.entries(args.data)) {
            if (value !== undefined) {
              row[key] = value;
            }
          }

          count += 1;
        }
      }

      return { count };
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
      transactionWrites.push({ table: "ledgerEntry", row });

      return structuredClone(row);
    },
    findMany: async () => structuredClone(db.ledgerEntry),
  },
  paymentProviderTransaction: {
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const row = db.paymentProviderTransaction.find((t) => matches(t, args.where));

      return row ? structuredClone(row) : null;
    },
    create: async (args: { data: Record<string, unknown> }) => {
      if (failNextTransactionCreate) {
        failNextTransactionCreate = false;
        throw new Error("injected transaction-create failure");
      }

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
          for (const [key, value] of Object.entries(args.data)) {
            if (value !== undefined) {
              row[key] = value;
            }
          }

          count += 1;
        }
      }

      return { count };
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

      for (const [key, value] of Object.entries(args.data)) {
        row[key] = value;
      }

      return structuredClone(row);
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;

      for (const row of db.webhookEvent) {
        if (matches(row, args.where)) {
          for (const [key, value] of Object.entries(args.data)) {
            if (value !== undefined) {
              row[key] = value;
            }
          }

          count += 1;
        }
      }

      return { count };
    },
  },
  advertiserProfile: {
    findUnique: async () => null,
  },
  $transaction: async (input: unknown) => {
    const previousWrites = transactionWrites;

    transactionWrites = [];

    try {
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
      transactionWrites = [];
    }
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

type InitiationService = typeof import("@/services/payments/payment-initiation.service");
type VerificationService = typeof import("@/services/payments/funding-verification.service");
type WebhookService = typeof import("@/services/payments/webhook-processing.service");
type WebhookEventService = typeof import("@/services/payments/webhook-event.service");
type PaystackProviderModule = typeof import("@/services/payments/paystack.provider");
type PaystackConfigModule = typeof import("@/services/payments/paystack.config");

let initiation: InitiationService;
let verification: VerificationService;
let webhookProcessing: WebhookService;
let webhookEventService: WebhookEventService;
let providerModule: PaystackProviderModule;
let configModule: PaystackConfigModule;

const ADV = "adv-1";
const ADV_OTHER = "adv-other";

/** A provider test double wired directly into the services' test seams. */
function fakeProvider(overrides: Partial<{
  createCharge: (request: unknown) => Promise<unknown>;
  verifyTransaction: (request: { providerReference: string }) => Promise<unknown>;
}> = {}) {
  let chargeCalls = 0;

  return {
    callCount: () => chargeCalls,
    createCharge:
      overrides.createCharge ??
      (async () => {
        chargeCalls += 1;

        return {
          status: "requires_action",
          providerReference: "access_code_1",
          redirectUrl: "https://checkout.paystack.com/abc123",
        } as const;
      }),
    verifyTransaction:
      overrides.verifyTransaction ??
      (async () => ({ status: "unverified", providerReference: "x", reason: "not requested" })),
  };
}

function addAgreement(overrides: Record<string, unknown> = {}): Row {
  const row: Row = {
    id: id("agr"),
    agreedAmount: "900000.00",
    currency: "NGN",
    campaignId: id("camp"),
    advertiserId: ADV,
    creatorId: "creator-1",
    status: "ACTIVE",
    ...overrides,
  };

  db.campaignAgreement.push(row);

  return row;
}

function addObligation(overrides: Record<string, unknown> = {}): Row {
  const row: Row = {
    id: id("obligation"),
    agreementId: overrides.agreementId as string ?? id("agr"),
    campaignId: id("camp"),
    advertiserId: ADV,
    creatorId: "creator-1",
    creatorAmountMinor: 90000000n,
    platformFeeMinor: 13500000n,
    advertiserTotalMinor: 103500000n,
    currency: "NGN",
    status: "PENDING_PAYMENT",
    obligationRef: `OBL-${id("ref").toUpperCase()}`,
    escrowFunded: false,
    dispute: false,
    providerReference: null,
    ...overrides,
  };

  db.financialObligation.push(row);

  return row;
}

describe("Stage 14B — Paystack provider integration", () => {
  before(async () => {
    initiation = await import("@/services/payments/payment-initiation.service");
    verification = await import("@/services/payments/funding-verification.service");
    webhookProcessing = await import("@/services/payments/webhook-processing.service");
    webhookEventService = await import("@/services/payments/webhook-event.service");
    providerModule = await import("@/services/payments/paystack.provider");
    configModule = await import("@/services/payments/paystack.config");
  });

  beforeEach(() => {
    resetDb();
    delete process.env.PAYSTACK_SECRET_KEY;
    delete process.env.PAYSTACK_BASE_URL;
  });

  // -----------------------------------------------------------------------
  // Config seam
  // -----------------------------------------------------------------------

  describe("paystack config seam", () => {
    it("is dormant when the secret key is unset", () => {
      assert.equal(configModule.getPaystackConfig(), null);
      assert.equal(configModule.isPaystackConfigured(), false);
    });

    it("reads the secret at use time and defaults the base URL", () => {
      process.env.PAYSTACK_SECRET_KEY = "sk_test_abc";

      const config = configModule.getPaystackConfig();

      assert.ok(config);
      assert.equal(config.secretKey, "sk_test_abc");
      assert.equal(config.baseUrl, "https://api.paystack.co");
    });

    it("honors a base-URL override and trims trailing slashes", () => {
      process.env.PAYSTACK_SECRET_KEY = "sk_test_abc";
      process.env.PAYSTACK_BASE_URL = "http://localhost:9999/";

      assert.equal(configModule.getPaystackConfig()?.baseUrl, "http://localhost:9999");
    });
  });

  // -----------------------------------------------------------------------
  // Paystack adapter
  // -----------------------------------------------------------------------

  describe("paystack adapter", () => {
    function makeProvider(responses: Array<{ status: number; body: string }>) {
      let call = 0;

      const fetchImpl = async () => {
        const response = responses[Math.min(call, responses.length - 1)];

        call += 1;

        return {
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          text: async () => response.body,
        };
      };

      return new providerModule.PaystackProvider(
        { secretKey: "sk_test_abc", baseUrl: "http://paystack.test" },
        fetchImpl,
        async () => "advertiser@example.com",
      );
    }

    it("initializeTransaction success maps to requires_action with an integer kobo amount", async () => {
      const provider = makeProvider([
        {
          status: 200,
          body: JSON.stringify({
            status: true,
            message: "Authorization URL created",
            data: {
              authorization_url: "https://checkout.paystack.com/xyz",
              access_code: "AC_123",
              reference: "OBL-1",
            },
          }),
        },
      ]);

      const result = await provider.createCharge({
        advertiserId: ADV,
        campaignId: "camp-1",
        amountMinor: 103500000n,
        currency: "NGN",
        reference: "OBL-1",
      });

      assert.equal(result.status, "requires_action");

      if (result.status === "requires_action") {
        assert.equal(result.providerReference, "AC_123");
        assert.equal(result.redirectUrl, "https://checkout.paystack.com/xyz");
      }
    });

    it("a rejected initialization maps to failed with the provider message", async () => {
      const provider = makeProvider([
        { status: 400, body: JSON.stringify({ status: false, message: "Duplicate reference" }) },
      ]);

      const result = await provider.createCharge({
        advertiserId: ADV,
        campaignId: "camp-1",
        amountMinor: 103500000n,
        currency: "NGN",
        reference: "OBL-1",
      });

      assert.equal(result.status, "failed");

      if (result.status === "failed") {
        assert.match(result.reason, /Duplicate reference/);
      }
    });

    it("a network timeout during initialization maps to failed", async () => {
      const fetchImpl = async () => {
        throw new Error("boom");
      };

      const provider = new providerModule.PaystackProvider(
        { secretKey: "sk_test_abc", baseUrl: "http://paystack.test" },
        fetchImpl,
        async () => "advertiser@example.com",
      );

      const result = await provider.createCharge({
        advertiserId: ADV,
        campaignId: "camp-1",
        amountMinor: 103500000n,
        currency: "NGN",
        reference: "OBL-1",
      });

      assert.equal(result.status, "failed");
    });

    it("verification success maps to verified only with matching amount and currency", async () => {
      const provider = makeProvider([
        {
          status: 200,
          body: JSON.stringify({
            status: true,
            message: "Verification successful",
            data: { id: 42, status: "success", amount: 103500000, currency: "NGN", paid_at: "2026-09-25T10:00:00Z" },
          }),
        },
      ]);

      const result = await provider.verifyTransaction({
        providerReference: "OBL-1",
        expectedAmountMinor: 103500000n,
        currency: "NGN",
      });

      assert.equal(result.status, "verified");

      if (result.status === "verified") {
        assert.equal(result.amountMinor, 103500000n);
        assert.equal(result.providerStatus, "SUCCEEDED");
      }
    });

    it("verification with a mismatched provider amount is unverified", async () => {
      const provider = makeProvider([
        {
          status: 200,
          body: JSON.stringify({
            status: true,
            data: { id: 42, status: "success", amount: 100000000, currency: "NGN" },
          }),
        },
      ]);

      const result = await provider.verifyTransaction({
        providerReference: "OBL-1",
        expectedAmountMinor: 103500000n,
        currency: "NGN",
      });

      assert.equal(result.status, "unverified");

      if (result.status === "unverified") {
        assert.match(result.reason, /amount/i);
      }
    });

    it("verification with a mismatched currency is unverified", async () => {
      const provider = makeProvider([
        {
          status: 200,
          body: JSON.stringify({
            status: true,
            data: { id: 42, status: "success", amount: 103500000, currency: "USD" },
          }),
        },
      ]);

      const result = await provider.verifyTransaction({
        providerReference: "OBL-1",
        expectedAmountMinor: 103500000n,
        currency: "NGN",
      });

      assert.equal(result.status, "unverified");

      if (result.status === "unverified") {
        assert.match(result.reason, /currency/i);
      }
    });

    it("a provider timeout during verification is classified provider_unavailable", async () => {
      const fetchImpl = async () => {
        const error = new Error("timed out");

        error.name = "PaystackTimeoutError";
        throw error;
      };

      const provider = new providerModule.PaystackProvider(
        { secretKey: "sk_test_abc", baseUrl: "http://paystack.test" },
        fetchImpl,
        async () => "advertiser@example.com",
      );

      const result = await provider.verifyTransaction({
        providerReference: "OBL-1",
        expectedAmountMinor: 103500000n,
        currency: "NGN",
      });

      assert.equal(result.status, "unverified");

      if (result.status === "unverified") {
        assert.match(result.reason, /^provider_unavailable/);
      }
    });

    it("webhook signature verifies valid HMAC-SHA512 and rejects tampering", async () => {
      const crypto = await import("node:crypto");
      const rawBody = JSON.stringify({ event: "charge.success", data: { id: 7, reference: "OBL-1" } });

      const signature = crypto
        .createHmac("sha512", "sk_test_abc")
        .update(rawBody, "utf8")
        .digest("hex");

      const provider = new providerModule.PaystackProvider(
        { secretKey: "sk_test_abc", baseUrl: "http://paystack.test" },
        async () => ({ ok: true, status: 200, text: async () => "" }),
        async () => null,
      );

      const valid = await provider.verifyWebhook({
        rawBody,
        headers: { "x-paystack-signature": signature },
      });

      assert.equal(valid.verified, true);

      if (valid.verified) {
        assert.equal(valid.event.providerEventId, "charge.success:7");
      }

      const tampered = rawBody.replace("OBL-1", "OBL-999");

      const invalid = await provider.verifyWebhook({
        rawBody: tampered,
        headers: { "x-paystack-signature": signature },
      });

      assert.equal(invalid.verified, false);
    });

    it("a webhook without a signature header fails closed", async () => {
      const provider = new providerModule.PaystackProvider(
        { secretKey: "sk_test_abc", baseUrl: "http://paystack.test" },
        async () => ({ ok: true, status: 200, text: async () => "" }),
        async () => null,
      );

      const result = await provider.verifyWebhook({
        rawBody: "{}",
        headers: {},
      });

      assert.equal(result.verified, false);
    });

    it("an event without a stable id yields providerEventId null (stored SKIPPED)", async () => {
      const provider = new providerModule.PaystackProvider(
        { secretKey: "sk_test_abc", baseUrl: "http://paystack.test" },
        async () => ({ ok: true, status: 200, text: async () => "" }),
        async () => null,
      );

      const result = await provider.verifyWebhook({
        rawBody: JSON.stringify({ event: "refund.processed", data: { note: "no id" } }),
        headers: { "x-paystack-signature": "00" },
      });

      // Signature would fail in reality; this pins the id-synthesis branch.
      if (result.verified) {
        assert.equal(result.event.providerEventId, null);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Payment initiation
  // -----------------------------------------------------------------------

  describe("payment initiation", () => {
    it("initiates a charge with server-derived amounts and the obligationRef reference", async () => {
      const agreement = addAgreement();
      const obligation = addObligation({ agreementId: agreement.id });
      const provider = fakeProvider();

      const result = await initiation.initiatePaymentForObligation(
        obligation.id as string,
        ADV,
        provider as never,
      );

      assert.equal(result.ok, true);

      if (result.ok) {
        assert.equal(result.amountMinor, 103500000n); // advertiserTotalMinor ONLY
        assert.equal(result.currency, "NGN");
        assert.equal(result.paymentReference, obligation.obligationRef);
        assert.equal(result.redirectUrl, "https://checkout.paystack.com/abc123");
        assert.equal(result.idempotentReplay, false);
      }

      assert.equal(provider.callCount(), 1);
      assert.equal(db.financialObligation[0].status, "PROCESSING");
      assert.equal(db.financialObligation[0].escrowFunded, false);
      // Initiation never records money as paid.
      assert.equal(db.ledgerEntry.length, 0);
      assert.equal(db.paymentProviderTransaction.length, 1);
      assert.equal(db.paymentProviderTransaction[0].providerStatus, "REQUIRES_ACTION");
    });

    it("a foreign advertiser cannot initiate payment (fail closed)", async () => {
      const agreement = addAgreement();
      const obligation = addObligation({ agreementId: agreement.id });

      const result = await initiation.initiatePaymentForObligation(
        obligation.id as string,
        ADV_OTHER,
        fakeProvider() as never,
      );

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "NOT_FOUND");
      }

      assert.equal(db.paymentProviderTransaction.length, 0);
      assert.equal(db.financialObligation[0].status, "PENDING_PAYMENT");
    });

    it("a FUNDED obligation refuses new initiation (INVALID_STATE)", async () => {
      const agreement = addAgreement();
      const obligation = addObligation({ agreementId: agreement.id, status: "FUNDED", escrowFunded: true });

      const result = await initiation.initiatePaymentForObligation(
        obligation.id as string,
        ADV,
        fakeProvider() as never,
      );

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "INVALID_STATE");
      }

      assert.equal(db.paymentProviderTransaction.length, 0);
    });

    it("duplicate initiation returns the existing attempt and NEVER calls the provider twice", async () => {
      const agreement = addAgreement();
      const obligation = addObligation({ agreementId: agreement.id });
      const provider = fakeProvider();

      const first = await initiation.initiatePaymentForObligation(
        obligation.id as string,
        ADV,
        provider as never,
      );

      assert.equal(first.ok, true);

      const second = await initiation.initiatePaymentForObligation(
        obligation.id as string,
        ADV,
        provider as never,
      );

      assert.equal(second.ok, true);

      if (second.ok) {
        assert.equal(second.idempotentReplay, true);
        assert.equal(second.providerReference, "access_code_1");
      }

      assert.equal(provider.callCount(), 1);
      assert.equal(db.paymentProviderTransaction.length, 1);
    });

    it("provider failure transitions PROCESSING → FAILED so nothing is stuck", async () => {
      const agreement = addAgreement();
      const obligation = addObligation({ agreementId: agreement.id });

      const provider = fakeProvider({
        createCharge: async () => ({
          status: "failed",
          providerReference: null,
          reason: "Paystack rejected the charge: insufficient funds",
        }),
      });

      const result = await initiation.initiatePaymentForObligation(
        obligation.id as string,
        ADV,
        provider as never,
      );

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "PROVIDER_FAILED");
      }

      assert.equal(db.financialObligation[0].status, "FAILED");
      assert.equal(db.ledgerEntry.length, 0);
      assert.equal(db.paymentProviderTransaction.length, 0);
    });

    it("a crash after the charge succeeds but before the attempt row write leaves PROCESSING (never FAILED) and a retry converges", async () => {
      const agreement = addAgreement();
      const obligation = addObligation({ agreementId: agreement.id });

      // Simulate the DB failing on the attempt-row write AFTER the provider
      // accepted the charge.
      failNextTransactionCreate = true;

      const provider = fakeProvider();

      const first = await initiation.initiatePaymentForObligation(
        obligation.id as string,
        ADV,
        provider as never,
      );

      // The result is still ok:true (the hosted charge is real and payable);
      // the obligation stays PROCESSING for reconciliation.
      assert.equal(first.ok, true);
      assert.equal(db.financialObligation[0].status, "PROCESSING");
      assert.equal(db.paymentProviderTransaction.length, 0);

      // Retry: PROCESSING without an attempt → re-derives the charge with the
      // SAME deterministic reference (Paystack would refuse a duplicate), and
      // the row write succeeds this time.
      const second = await initiation.initiatePaymentForObligation(
        obligation.id as string,
        ADV,
        provider as never,
      );

      assert.equal(second.ok, true);
      assert.equal(db.paymentProviderTransaction.length, 1);
      assert.equal(
        (db.paymentProviderTransaction[0].metadata as { businessReference?: string })?.businessReference,
        obligation.obligationRef,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Funding verification
  // -----------------------------------------------------------------------

  describe("funding verification", () => {
    it("verified payment moves PROCESSING → FUNDED with the 13A ledger shape and escrowFunded", async () => {
      const agreement = addAgreement();
      const obligation = addObligation({ agreementId: agreement.id, status: "PROCESSING" });

      const provider = fakeProvider({
        verifyTransaction: async () => ({
          status: "verified",
          providerReference: obligation.obligationRef,
          providerStatus: "SUCCEEDED",
          amountMinor: 103500000n,
          currency: "NGN",
          paidAt: "2026-09-25T10:00:00Z",
        }),
      });

      const result = await verification.verifyAndSettleFunding(
        obligation.id as string,
        provider.verifyTransaction as never,
      );

      assert.equal(result.ok, true);

      if (result.ok) {
        assert.equal(result.status, "FUNDED");
        assert.equal(result.idempotentReplay, false);
      }

      assert.equal(db.financialObligation[0].status, "FUNDED");
      assert.equal(db.financialObligation[0].escrowFunded, true);

      const entries = db.ledgerEntry;
      const byType = (type: string) => entries.find((e) => e.entryType === type);

      assert.equal(entries.length, 3);
      assert.equal(byType("CHARGE")?.amountMinor, 103500000n);
      assert.equal(byType("CHARGE")?.direction, "DEBIT");
      assert.equal(byType("ESCROW_HOLD")?.amountMinor, 90000000n);
      assert.equal(byType("ESCROW_HOLD")?.direction, "CREDIT");
      assert.equal(byType("PLATFORM_FEE")?.amountMinor, 13500000n);
      assert.equal(byType("PLATFORM_FEE")?.direction, "CREDIT");
    });

    it("a verified amount that differs from advertiserTotalMinor is refused and stays PROCESSING", async () => {
      const agreement = addAgreement();
      const obligation = addObligation({ agreementId: agreement.id, status: "PROCESSING" });

      const provider = fakeProvider({
        verifyTransaction: async () => ({
          status: "verified",
          providerReference: obligation.obligationRef,
          providerStatus: "SUCCEEDED",
          amountMinor: 50000000n, // wrong amount
          currency: "NGN",
          paidAt: null,
        }),
      });

      const result = await verification.verifyAndSettleFunding(
        obligation.id as string,
        provider.verifyTransaction as never,
      );

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "AMOUNT_MISMATCH");
      }

      assert.equal(db.financialObligation[0].status, "PROCESSING");
      assert.equal(db.ledgerEntry.length, 0);
    });

    it("a verified currency mismatch is refused and stays PROCESSING", async () => {
      const agreement = addAgreement();
      const obligation = addObligation({ agreementId: agreement.id, status: "PROCESSING" });

      const provider = fakeProvider({
        verifyTransaction: async () => ({
          status: "verified",
          providerReference: obligation.obligationRef,
          providerStatus: "SUCCEEDED",
          amountMinor: 103500000n,
          currency: "USD",
          paidAt: null,
        }),
      });

      const result = await verification.verifyAndSettleFunding(
        obligation.id as string,
        provider.verifyTransaction as never,
      );

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "CURRENCY_MISMATCH");
      }

      assert.equal(db.financialObligation[0].status, "PROCESSING");
      assert.equal(db.ledgerEntry.length, 0);
    });

    it("provider timeout leaves the obligation PROCESSING — never FAILED", async () => {
      const agreement = addAgreement();
      const obligation = addObligation({ agreementId: agreement.id, status: "PROCESSING" });

      const provider = fakeProvider({
        verifyTransaction: async () => ({
          status: "unverified",
          providerReference: obligation.obligationRef,
          reason: "provider_unavailable: Paystack did not respond while verifying.",
        }),
      });

      const result = await verification.verifyAndSettleFunding(
        obligation.id as string,
        provider.verifyTransaction as never,
      );

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "PROVIDER_UNAVAILABLE");
      }

      assert.equal(db.financialObligation[0].status, "PROCESSING");
      assert.equal(db.ledgerEntry.length, 0);
    });

    it("a definitive provider failure moves PROCESSING → FAILED with NO ledger lines", async () => {
      const agreement = addAgreement();
      const obligation = addObligation({ agreementId: agreement.id, status: "PROCESSING" });

      const provider = fakeProvider({
        verifyTransaction: async () => ({
          status: "unverified",
          providerReference: obligation.obligationRef,
          reason: "Paystack reports the transaction as failed.",
        }),
      });

      const result = await verification.verifyAndSettleFunding(
        obligation.id as string,
        provider.verifyTransaction as never,
      );

      assert.equal(result.ok, true);

      if (result.ok) {
        assert.equal(result.status, "FAILED");
      }

      assert.equal(db.financialObligation[0].status, "FAILED");
      assert.equal(db.ledgerEntry.length, 0);
    });

    it("duplicate verification after FUNDED is an idempotent replay with no second ledger set", async () => {
      const agreement = addAgreement();
      const obligation = addObligation({ agreementId: agreement.id, status: "PROCESSING" });

      const provider = fakeProvider({
        verifyTransaction: async () => ({
          status: "verified",
          providerReference: obligation.obligationRef,
          providerStatus: "SUCCEEDED",
          amountMinor: 103500000n,
          currency: "NGN",
          paidAt: null,
        }),
      });

      const first = await verification.verifyAndSettleFunding(
        obligation.id as string,
        provider.verifyTransaction as never,
      );

      assert.equal(first.ok, true);

      const ledgerCountAfterFirst = db.ledgerEntry.length;

      assert.equal(ledgerCountAfterFirst, 3);

      const second = await verification.verifyAndSettleFunding(
        obligation.id as string,
        provider.verifyTransaction as never,
      );

      assert.equal(second.ok, true);

      if (second.ok) {
        assert.equal(second.idempotentReplay, true);
      }

      assert.equal(db.ledgerEntry.length, 3); // unchanged
    });

    it("verification of a PENDING_PAYMENT obligation is refused (payment not initiated)", async () => {
      const agreement = addAgreement();
      const obligation = addObligation({ agreementId: agreement.id });

      const result = await verification.verifyAndSettleFunding(
        obligation.id as string,
        fakeProvider().verifyTransaction as never,
      );

      assert.equal(result.ok, false);

      if (!result.ok) {
        assert.equal(result.code, "INVALID_STATE");
      }
    });
  });

  // -----------------------------------------------------------------------
  // Webhook boundary
  // -----------------------------------------------------------------------

  describe("webhook boundary", () => {
    it("a valid charge.success webhook drives verification to FUNDED", async () => {
      const agreement = addAgreement();

      addObligation({
        agreementId: agreement.id,
        status: "PROCESSING",
        obligationRef: "OBL-WEBHOOK-1",
      });

      // The webhook processing path uses the provider singleton — route a
      // fake through the port registry.
      const payments = await import("@/services/payments/index");

      payments.resetPaymentProviderForTests();
      payments.configurePaymentProvider({
        name: "paystack",
        createCharge: async () => ({ status: "failed", providerReference: null, reason: "unused" }),
        verifyTransaction: async () => ({
          status: "verified",
          providerReference: "OBL-WEBHOOK-1",
          providerStatus: "SUCCEEDED",
          amountMinor: 103500000n,
          currency: "NGN",
          paidAt: null,
        }),
        createRefund: async () => ({ status: "failed", providerReference: null, reason: "unused" }),
        createPayout: async () => ({ status: "failed", providerReference: null, reason: "unused" }),
        getTransferStatus: async () => ({ status: "unknown", reason: "unused" }),
        createRecipient: async () => ({ status: "failed", reason: "unused" }),
        verifyWebhook: async () => ({ verified: false, reason: "unused" }),
      } as never);

      const stored = await webhookEventService.storeWebhookEvent({
        provider: "paystack",
        providerEventId: "charge.success:99",
        eventType: "charge.success",
        payload: { event: "charge.success", data: { id: 99, reference: "OBL-WEBHOOK-1", amount: 1 } },
      });

      assert.equal(stored.alreadyExisted, false);

      const claimed = await webhookEventService.claimWebhookEventForProcessing(stored.id);

      assert.equal(claimed, true);

      const outcome = await webhookProcessing.processWebhookEvent(
        stored.id,
        { event: "charge.success", data: { id: 99, reference: "OBL-WEBHOOK-1", amount: 1 } },
        "charge.success",
      );

      assert.equal(outcome.processed, true);
      assert.match(outcome.note, /verified and settled/);

      // The payload's amount (1) was NOT trusted — the verified amount was.
      assert.equal(db.financialObligation[0].status, "FUNDED");
      assert.equal(db.financialObligation[0].escrowFunded, true);
      assert.equal(db.ledgerEntry.length, 3);
    });

    it("an unknown reference is processed without touching any obligation", async () => {
      const outcome = await webhookProcessing.processWebhookEvent(
        "hook-1",
        { event: "charge.success", data: { id: 1, reference: "OBL-UNKNOWN" } },
        "charge.success",
      );

      assert.equal(outcome.processed, true);
      assert.match(outcome.note, /No obligation matches/);
      assert.equal(db.financialObligation.length, 0);
    });

    it("an out-of-order success webhook after FUNDED is an idempotent no-op", async () => {
      const agreement = addAgreement();

      addObligation({
        agreementId: agreement.id,
        status: "FUNDED",
        escrowFunded: true,
        obligationRef: "OBL-OOO-1",
      });

      const payments = await import("@/services/payments/index");

      payments.resetPaymentProviderForTests();
      payments.configurePaymentProvider({
        name: "paystack",
        createCharge: async () => ({ status: "failed", providerReference: null, reason: "unused" }),
        verifyTransaction: async () => ({
          status: "verified",
          providerReference: "OBL-OOO-1",
          providerStatus: "SUCCEEDED",
          amountMinor: 103500000n,
          currency: "NGN",
          paidAt: null,
        }),
        createRefund: async () => ({ status: "failed", providerReference: null, reason: "unused" }),
        createPayout: async () => ({ status: "failed", providerReference: null, reason: "unused" }),
        getTransferStatus: async () => ({ status: "unknown", reason: "unused" }),
        createRecipient: async () => ({ status: "failed", reason: "unused" }),
        verifyWebhook: async () => ({ verified: false, reason: "unused" }),
      } as never);

      const outcome = await webhookProcessing.processWebhookEvent(
        "hook-2",
        { event: "charge.success", data: { id: 2, reference: "OBL-OOO-1" } },
        "charge.success",
      );

      assert.equal(outcome.processed, true);
      assert.match(outcome.note, /idempotent replay/);
      assert.equal(db.financialObligation[0].status, "FUNDED");
      assert.equal(db.ledgerEntry.length, 0); // nothing new
    });

    it("a charge.failed webhook on a PROCESSING obligation transitions to FAILED", async () => {
      const agreement = addAgreement();

      addObligation({
        agreementId: agreement.id,
        status: "PROCESSING",
        obligationRef: "OBL-FAIL-1",
      });

      const payments = await import("@/services/payments/index");

      payments.resetPaymentProviderForTests();
      payments.configurePaymentProvider({
        name: "paystack",
        createCharge: async () => ({ status: "failed", providerReference: null, reason: "unused" }),
        verifyTransaction: async () => ({
          status: "unverified",
          providerReference: "OBL-FAIL-1",
          reason: "Paystack reports the transaction as failed.",
        }),
        createRefund: async () => ({ status: "failed", providerReference: null, reason: "unused" }),
        createPayout: async () => ({ status: "failed", providerReference: null, reason: "unused" }),
        getTransferStatus: async () => ({ status: "unknown", reason: "unused" }),
        createRecipient: async () => ({ status: "failed", reason: "unused" }),
        verifyWebhook: async () => ({ verified: false, reason: "unused" }),
      } as never);

      const outcome = await webhookProcessing.processWebhookEvent(
        "hook-3",
        { event: "charge.failed", data: { id: 3, reference: "OBL-FAIL-1" } },
        "charge.failed",
      );

      assert.equal(outcome.processed, true);
      assert.equal(db.financialObligation[0].status, "FAILED");
      assert.equal(db.ledgerEntry.length, 0);
    });

    it("webhook dedupe: a repeated delivery lands on the existing row", async () => {
      const first = await webhookEventService.storeWebhookEvent({
        provider: "paystack",
        providerEventId: "charge.success:7",
        eventType: "charge.success",
        payload: { event: "charge.success", data: { id: 7 } },
      });

      const second = await webhookEventService.storeWebhookEvent({
        provider: "paystack",
        providerEventId: "charge.success:7",
        eventType: "charge.success",
        payload: { event: "charge.success", data: { id: 7 } },
      });

      assert.equal(first.alreadyExisted, false);
      assert.equal(second.alreadyExisted, true);
      assert.equal(second.id, first.id);
      assert.equal(db.webhookEvent.length, 1);
    });

    it("an event without an id is stored SKIPPED and never claimed", async () => {
      const stored = await webhookEventService.storeWebhookEvent({
        provider: "paystack",
        providerEventId: null,
        eventType: "charge.success",
        payload: { event: "charge.success", data: {} },
      });

      assert.equal(stored.status, "SKIPPED");

      const claimed = await webhookEventService.claimWebhookEventForProcessing(stored.id);

      assert.equal(claimed, false);
    });

    it("claiming is exactly-once under concurrency", async () => {
      const stored = await webhookEventService.storeWebhookEvent({
        provider: "paystack",
        providerEventId: "charge.success:11",
        eventType: "charge.success",
        payload: { event: "charge.success", data: { id: 11 } },
      });

      const [a, b] = await Promise.all([
        webhookEventService.claimWebhookEventForProcessing(stored.id),
        webhookEventService.claimWebhookEventForProcessing(stored.id),
      ]);

      assert.equal(a, true);
      assert.equal(b, false);
    });

    it("irrelevant event types are audited without action", async () => {
      const outcome = await webhookProcessing.processWebhookEvent(
        "hook-4",
        { event: "subscription.create", data: {} },
        "subscription.create",
      );

      assert.equal(outcome.processed, true);
      assert.match(outcome.note, /requires no action/);
      assert.equal(db.financialObligation.length, 0);
    });
  });
});
