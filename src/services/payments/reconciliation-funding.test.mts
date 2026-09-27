import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Funding reconciliation — obligation-level re-verification through the
 * EXISTING Stage 14B gate (verifyAndSettleFunding), driven by the scheduled
 * reconciliation scan.
 *
 * Same harness convention as the 14A/14B/14D/14E suites: an in-memory Prisma
 * stub with unique-constraint simulation AND per-transaction rollback,
 * registered via mock.module BEFORE the modules under test are imported.
 * Verification outcomes are injected through the funding-verification
 * service's own providerOverride test seam — reconciliation never duplicates
 * verification logic.
 *
 * Pins the reconciliation matrix:
 *   - stale PROCESSING + provider verified → FUNDED exactly once (ledger +
 *     event written once, obligation re-denormalizes the charge reference);
 *   - stale PROCESSING + provider still pending/unverifiable → stays
 *     PROCESSING (staleness is never failure, never a forced transition);
 *   - stale PROCESSING + provider definitively failed (via the verification
 *     gate's own evidence path) → FAILED with NO ledger lines;
 *   - amount mismatch / currency mismatch → refused by the gate, stays
 *     PROCESSING, nothing written;
 *   - no recorded provider attempt → safe handling: reported as noAttempt,
 *     NO verification call, nothing invented;
 *   - latest attempt definitively FAILED → skipped (never re-verified, never
 *     auto-failed — staleness is not evidence);
 *   - dormant mode (no provider configured) → safe handling: reported via
 *     PROVIDER_UNCONFIGURED, no check performed (providerChecksPerformed
 *     stays false), the obligation stays PROCESSING;
 *   - obligation no longer PROCESSING when the gate runs → INVALID_STATE,
 *     no check performed (a concurrent webhook moved it), untouched;
 *   - repeated reconciliation → idempotent (already FUNDED replays, no
 *     duplicate events/ledger);
 *   - concurrent scans → the conditional FUNDED update arbitrates; exactly
 *     one winner writes, no duplicate accounting rows;
 *   - non-stale PROCESSING → untouched;
 *   - non-PROCESSING states → untouched.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma stub
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { id: string };

const db: Record<string, Row[]> = {
  financialObligation: [],
  financialEvent: [],
  ledgerEntry: [],
  paymentProviderTransaction: [],
  milestone: [],
};

let nextId = 1;
const id = (prefix: string) => `${prefix}-${nextId++}`;

function resetDb(): void {
  for (const table of Object.keys(db)) {
    db[table] = [];
  }

  nextId = 1;
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
      if ("not" in operators && row[key] === operators.not) return false;
      if ("lt" in operators && !((row[key] as Date) < (operators.lt as Date))) return false;
      if ("notIn" in operators && (operators.notIn as unknown[]).includes(row[key])) return false;

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
    findUnique: async (args: { where: { id?: string; agreementId?: string } }) => {
      const row = db.financialObligation.find(
        (o) =>
          (args.where.id === undefined || o.id === args.where.id) &&
          (args.where.agreementId === undefined || o.agreementId === args.where.agreementId),
      );

      return row ? structuredClone(row) : null;
    },
    findMany: async (args: { where?: Record<string, unknown> }) => {
      const rows = db.financialObligation
        .filter((o) => matches(o, args.where ?? {}))
        .map((o) => structuredClone(o));

      // updatedAt asc is the only ordering the scan asks for.
      return rows.sort(
        (a, b) => (a.updatedAt as Date).getTime() - (b.updatedAt as Date).getTime(),
      );
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
    findUnique: async (args: {
      where: { provider_providerReference?: { provider: string; providerReference: string } };
    }) => {
      const key = args.where.provider_providerReference;

      if (!key) {
        return null;
      }

      const row = db.paymentProviderTransaction.find(
        (t) =>
          t.provider === key.provider && t.providerReference === key.providerReference,
      );

      return row ? structuredClone(row) : null;
    },
    create: async (args: { data: Record<string, unknown> }) => {
      const row = {
        providerStatus: "PENDING",
        ...args.data,
        id: typeof args.data.id === "string" ? args.data.id : id("tx"),
      } as Row;

      enforceUnique("paymentProviderTransaction", row, [
        ["provider", "providerReference"],
        ["id"],
      ]);
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

/**
 * The provider singleton seam: the verification gate resolves the provider
 * through getPaymentProvider() in production. Tests inject a mutable holder
 * so each test can point the singleton at its own double (or clear it to
 * simulate the dormant mode).
 */
let activeProvider: { verifyTransaction: (request: {
  providerReference: string;
  expectedAmountMinor: bigint;
  currency: string;
}) => Promise<unknown> } | null = null;

mockModule("@/services/payments/index", {
  getPaymentProvider: () => {
    if (!activeProvider) {
      throw new (class PaymentsNotImplementedError extends Error {})();
    }

    return activeProvider;
  },
  hasPaymentProvider: () => activeProvider !== null,
});

type ReconciliationService = typeof import("@/services/payments/reconciliation.service");
type VerificationService = typeof import("@/services/payments/funding-verification.service");

let reconciliation: ReconciliationService;
let verification: VerificationService;

/** The obligation's frozen amounts (₦900,000 creator + 15% fee). */
const CREATOR_AMOUNT = 90000000n;
const PLATFORM_FEE = 13500000n;
const ADVERTISER_TOTAL = 103500000n;

function addObligation(overrides: Record<string, unknown> = {}): Row {
  const row: Row = {
    id: id("obligation"),
    agreementId: id("agr"),
    campaignId: id("camp"),
    advertiserId: "adv-1",
    creatorId: "creator-1",
    creatorAmountMinor: CREATOR_AMOUNT,
    platformFeeMinor: PLATFORM_FEE,
    advertiserTotalMinor: ADVERTISER_TOTAL,
    currency: "NGN",
    status: "PROCESSING",
    obligationRef: `OBL-${id("ref").toUpperCase()}`,
    escrowFunded: false,
    dispute: false,
    providerReference: null,
    createdAt: new Date(),
    updatedAt: new Date(Date.now() - 45 * 60 * 1000), // stale by default (> 30 min)
    ...overrides,
  };

  db.financialObligation.push(row);

  return row;
}

/** A recorded charge attempt (the initiation crash-window / completed write). */
function addAttempt(obligation: Row, overrides: Record<string, unknown> = {}): Row {
  const row = {
    id: `tx-${nextId++}`,
    obligationId: obligation.id,
    provider: "paystack",
    providerReference: `access_code_${nextId}`,
    providerStatus: "REQUIRES_ACTION",
    amountMinor: ADVERTISER_TOTAL,
    currency: "NGN",
    initiatedAt: new Date(Date.now() - 40 * 60 * 1000),
    ...overrides,
  } as Row;

  db.paymentProviderTransaction.push(row);

  return row;
}

/**
 * A provider double for the verification gate's own test seam. Outcomes:
 *   - "verified": the provider reports success for the expected amount/currency;
 *   - "unverified:reason": the provider cannot establish a definitive result
 *     (pending / malformed / non-integer / provider reports another status);
 *   - "provider_unavailable:reason": timeout/network uncertainty;
 *   - "definitive_failure:reason": the provider reports failed/abandoned/reversed.
 */
function providerFor(
  mode:
    | "verified"
    | "pending"
    | "unavailable"
    | "definitive_failure"
    | { kind: "amount_mismatch"; amountMinor: bigint }
    | { kind: "currency_mismatch"; currency: string },
) {
  let calls = 0;

  const double = {
    callCount: () => calls,
    verifyTransaction: async (request: {
      providerReference: string;
      expectedAmountMinor: bigint;
      currency: string;
    }) => {
      calls += 1;

      if (mode === "verified") {
        return {
          status: "verified" as const,
          providerReference: request.providerReference,
          providerStatus: "SUCCEEDED" as const,
          amountMinor: request.expectedAmountMinor,
          currency: request.currency,
          paidAt: new Date().toISOString(),
          raw: {},
        };
      }

      if (mode === "pending") {
        return {
          status: "unverified" as const,
          providerReference: request.providerReference,
          reason: "Paystack reports the transaction as pending.",
        };
      }

      if (mode === "unavailable") {
        return {
          status: "unverified" as const,
          providerReference: request.providerReference,
          reason: "provider_unavailable: Paystack did not respond while verifying.",
        };
      }

      if (mode === "definitive_failure") {
        return {
          status: "unverified" as const,
          providerReference: request.providerReference,
          reason: "Paystack reports the transaction as failed.",
        };
      }

      if (typeof mode === "object" && mode.kind === "amount_mismatch") {
        return {
          status: "verified" as const,
          providerReference: request.providerReference,
          providerStatus: "SUCCEEDED" as const,
          amountMinor: mode.amountMinor,
          currency: request.currency,
          paidAt: null,
          raw: {},
        };
      }

      return {
        status: "verified" as const,
        providerReference: request.providerReference,
        providerStatus: "SUCCEEDED" as const,
        amountMinor: request.expectedAmountMinor,
        currency: mode.currency,
        paidAt: null,
        raw: {},
      };
    },
  };

  // The verification gate resolves the provider through the payments-port
  // singleton (mocked above); pointing `activeProvider` at the double makes
  // the REAL gate code answer with the test outcome.
  const override: VerifyOverride = async (request) => double.verifyTransaction(request);

  return { double, override, callCount: () => calls };
}

type VerifyRequest = { providerReference: string; expectedAmountMinor: bigint; currency: string };
type VerifyOverride = (request: VerifyRequest) => Promise<unknown>;

describe("Reconciliation — obligation-level funding re-verification", () => {
  before(async () => {
    reconciliation = await import("@/services/payments/reconciliation.service");
    verification = await import("@/services/payments/funding-verification.service");
  });

  beforeEach(() => {
    resetDb();
  });

  // -----------------------------------------------------------------------
  // Successful recovery
  // -----------------------------------------------------------------------

  it("re-verifies a stale PROCESSING obligation with a verified charge → FUNDED exactly once", async () => {
    const obligation = addObligation();
    const attempt = addAttempt(obligation, { providerReference: "access_code_recovered" });
    const provider = providerFor("verified");

    const report = await withProvider(provider.override, () =>
      reconciliation.runReconciliationScan({ now: new Date() }),
    );

    assert.equal(report.stuckCount, 1);
    assert.equal(report.funding.reverified, 1);
    assert.equal(report.funding.noAttempt, 0);
    assert.equal(report.funding.skippedFailedAttempt, 0);
    assert.equal(report.providerChecksPerformed, true);
    assert.deepEqual(report.funding.outcomes, [
      { obligationId: obligation.id, outcome: "FUNDED" },
    ]);

    // The obligation is FUNDED with the escrow flag, and the deterministic
    // business reference is denormalized onto it — the existing gate behavior
    // (the obligationRef IS the reference Paystack was charged under).
    assert.equal(obligation.status, "FUNDED");
    assert.equal(obligation.escrowFunded, true);
    assert.equal(obligation.providerReference, obligation.obligationRef);

    // The attempt row count is unchanged — no second attempt row, no new
    // provider reference was created (the gate's evidence-status update keys
    // on the obligationRef, per the existing 14B behavior).
    assert.equal(db.paymentProviderTransaction.length, 1);

    // Exactly the three 13A funding ledger lines, once.
    assert.equal(db.ledgerEntry.length, 3);
    assert.deepEqual(
      db.ledgerEntry.map((l) => l.entryType).sort(),
      ["CHARGE", "ESCROW_HOLD", "PLATFORM_FEE"],
    );

    // Exactly one verification event.
    const verifiedEvents = db.financialEvent.filter((e) => e.eventType === "payment_verified");
    assert.equal(verifiedEvents.length, 1);
    assert.equal(verifiedEvents[0].idempotencyKey, `evt:${obligation.id}:payment_verified`);
  });

  // -----------------------------------------------------------------------
  // Uncertainty is never failure
  // -----------------------------------------------------------------------

  it("keeps the obligation PROCESSING when the provider still reports pending/inconclusive", async () => {
    const obligation = addObligation();
    addAttempt(obligation);
    const provider = providerFor("pending");

    const report = await withProvider(provider.override, () =>
      reconciliation.runReconciliationScan({ now: new Date() }),
    );

    assert.equal(report.funding.reverified, 1);
    assert.equal(report.funding.outcomes[0].outcome, "PROCESSING");
    assert.equal(report.funding.outcomes[0].code, "UNVERIFIED");

    // Staleness is not failure: the obligation stays PROCESSING, untouched.
    assert.equal(obligation.status, "PROCESSING");
    assert.equal(obligation.escrowFunded, false);
    assert.equal(db.ledgerEntry.length, 0);

    // The one existing event (obligation_created + payment_initiated from
    // initiation) is untouched — no new events.
    assert.ok(!db.financialEvent.some((e) => e.eventType === "payment_verified"));
    assert.ok(!db.financialEvent.some((e) => e.eventType === "payment_failed"));
  });

  it("keeps the obligation PROCESSING when the provider is unavailable (timeout ≠ failure)", async () => {
    const obligation = addObligation();
    addAttempt(obligation);
    const provider = providerFor("unavailable");

    const report = await withProvider(provider.override, () =>
      reconciliation.runReconciliationScan({ now: new Date() }),
    );

    assert.equal(report.funding.outcomes[0].outcome, "unavailable");
    assert.equal(report.funding.outcomes[0].code, "PROVIDER_UNAVAILABLE");
    assert.equal(obligation.status, "PROCESSING");
    assert.equal(db.ledgerEntry.length, 0);
    assert.ok(!db.financialEvent.some((e) => e.eventType === "payment_failed"));
  });

  // -----------------------------------------------------------------------
  // Safe failure semantics
  // -----------------------------------------------------------------------

  it("marks FAILED only when the provider itself definitively reports failure — no ledger lines", async () => {
    const obligation = addObligation();
    const attempt = addAttempt(obligation);
    const provider = providerFor("definitive_failure");

    const report = await withProvider(provider.override, () =>
      reconciliation.runReconciliationScan({ now: new Date() }),
    );

    assert.equal(report.funding.outcomes[0].outcome, "FAILED");

    assert.equal(obligation.status, "FAILED");
    assert.equal(obligation.escrowFunded, false);

    // The failure event is the provider's own evidence path — and no ledger
    // lines: no money moved.
    const failedEvents = db.financialEvent.filter((e) => e.eventType === "payment_failed");
    assert.equal(failedEvents.length, 1);
    assert.equal(db.ledgerEntry.length, 0);

    // The attempt row is untouched by the failure path (the gate's evidence
    // update keys on the obligationRef, not the access-code row).
    assert.equal(db.paymentProviderTransaction.length, 1);
  });

  // -----------------------------------------------------------------------
  // Amount / currency mismatches never fund
  // -----------------------------------------------------------------------

  it("never funds on an amount mismatch — stays PROCESSING, nothing written", async () => {
    const obligation = addObligation();
    addAttempt(obligation);
    const provider = providerFor({ kind: "amount_mismatch", amountMinor: 1n });

    const report = await withProvider(provider.override, () =>
      reconciliation.runReconciliationScan({ now: new Date() }),
    );

    assert.equal(report.funding.outcomes[0].outcome, "PROCESSING");
    assert.equal(report.funding.outcomes[0].code, "AMOUNT_MISMATCH");

    assert.equal(obligation.status, "PROCESSING");
    assert.equal(obligation.escrowFunded, false);
    assert.equal(db.ledgerEntry.length, 0);
    assert.ok(!db.financialEvent.some((e) => e.eventType === "payment_verified"));
  });

  it("never funds on a currency mismatch — stays PROCESSING, nothing written", async () => {
    const obligation = addObligation();
    addAttempt(obligation);
    const provider = providerFor({ kind: "currency_mismatch", currency: "USD" });

    const report = await withProvider(provider.override, () =>
      reconciliation.runReconciliationScan({ now: new Date() }),
    );

    assert.equal(report.funding.outcomes[0].outcome, "PROCESSING");
    assert.equal(report.funding.outcomes[0].code, "CURRENCY_MISMATCH");

    assert.equal(obligation.status, "PROCESSING");
    assert.equal(db.ledgerEntry.length, 0);
  });

  // -----------------------------------------------------------------------
  // No invented verification
  // -----------------------------------------------------------------------

  it("skips an obligation with no recorded provider attempt — reported, never verified", async () => {
    addObligation(); // no attempt row at all
    const provider = providerFor("verified");

    const report = await withProvider(provider.override, () =>
      reconciliation.runReconciliationScan({ now: new Date() }),
    );

    assert.equal(report.stuckCount, 1);
    assert.equal(report.funding.noAttempt, 1);
    assert.equal(report.funding.reverified, 0);
    assert.equal(report.providerChecksPerformed, false);
    assert.equal(provider.callCount(), 0);

    // Nothing was invented: the obligation stays PROCESSING.
    assert.equal(db.financialObligation[0].status, "PROCESSING");
    assert.equal(db.ledgerEntry.length, 0);
  });

  it("skips an obligation whose latest attempt is definitively FAILED — never auto-fails from staleness", async () => {
    const obligation = addObligation();
    addAttempt(obligation, { providerStatus: "FAILED" });
    const provider = providerFor("verified"); // would fund if wrongly re-verified

    const report = await withProvider(provider.override, () =>
      reconciliation.runReconciliationScan({ now: new Date() }),
    );

    assert.equal(report.funding.skippedFailedAttempt, 1);
    assert.equal(report.funding.reverified, 0);
    assert.equal(provider.callCount(), 0);
    assert.equal(obligation.status, "PROCESSING");
    assert.equal(db.ledgerEntry.length, 0);
    assert.ok(!db.financialEvent.some((e) => e.eventType === "payment_verified"));
  });

  it("reports dormant mode without performing a provider check (PROVIDER_UNCONFIGURED, stays PROCESSING)", async () => {
    const obligation = addObligation();
    addAttempt(obligation);

    // No provider wired: `withProvider` sets a double, so run the scan with
    // the seam deliberately left dormant.
    activeProvider = null;

    const report = await reconciliation.runReconciliationScan({ now: new Date() });

    assert.equal(report.funding.reverified, 1);
    assert.equal(report.funding.outcomes[0].outcome, "PROCESSING");
    assert.equal(report.funding.outcomes[0].code, "PROVIDER_UNCONFIGURED");

    // F1: no provider exists → no provider check was performed.
    assert.equal(report.providerChecksPerformed, false);

    // The obligation is untouched and nothing was written.
    assert.equal(obligation.status, "PROCESSING");
    assert.equal(obligation.escrowFunded, false);
    assert.equal(db.ledgerEntry.length, 0);
    assert.equal(db.financialEvent.length, 0);
  });

  it("does not count a check when the gate refuses pre-provider (INVALID_STATE from a concurrent move)", async () => {
    const obligation = addObligation();
    addAttempt(obligation);
    const provider = providerFor("verified");

    // The obligation moves out of PROCESSING after the scan snapshot but
    // before the gate runs — the gate refuses with INVALID_STATE without
    // contacting the provider.
    const report = await withProvider(provider.override, async () => {
      const scanPromise = reconciliation.runReconciliationScan({ now: new Date() });

      obligation.status = "REFUND_PENDING";

      return scanPromise;
    });

    assert.equal(report.funding.outcomes[0].outcome, "PROCESSING");
    assert.equal(report.funding.outcomes[0].code, "INVALID_STATE");
    assert.equal(provider.callCount(), 0); // no provider contact
    assert.equal(report.providerChecksPerformed, false); // F1: pre-provider refusal
    assert.equal(obligation.status, "REFUND_PENDING");
    assert.equal(db.ledgerEntry.length, 0);
  });

  // -----------------------------------------------------------------------
  // Idempotency & concurrency
  // -----------------------------------------------------------------------

  it("repeated reconciliation is idempotent: an already-FUNDED obligation is replayed, not re-settled", async () => {
    const obligation = addObligation({ status: "FUNDED", escrowFunded: true, providerReference: "access_code_1" });
    addAttempt(obligation, { providerReference: "access_code_1", providerStatus: "SUCCEEDED" });

    // Seed the accounting rows a completed verification wrote.
    db.financialEvent.push({
      id: "fevt-seed",
      obligationId: obligation.id,
      agreementId: obligation.agreementId,
      eventType: "payment_verified",
      actor: "PROVIDER",
      source: "funding-verification",
      idempotencyKey: `evt:${obligation.id}:payment_verified`,
    } as Row);
    for (const entryType of ["CHARGE", "ESCROW_HOLD", "PLATFORM_FEE"]) {
      db.ledgerEntry.push({
        id: `ledger-seed-${entryType}`,
        account: "platform:escrow",
        direction: "CREDIT",
        amountMinor: CREATOR_AMOUNT,
        currency: "NGN",
        entryType,
        idempotencyKey: `evt:${obligation.id}:payment_verified:${entryType}:seed-account`,
      } as Row);
    }

    const provider = providerFor("verified");

    const report = await withProvider(provider.override, () =>
      reconciliation.runReconciliationScan({ now: new Date() }),
    );

    // A FUNDED obligation is not a stuck PROCESSING row — it is not even
    // scanned, so no call, no duplicate writes.
    assert.equal(report.stuckCount, 0);
    assert.equal(report.funding.reverified, 0);
    assert.equal(provider.callCount(), 0);
    assert.equal(db.financialEvent.length, 1);
    assert.equal(db.ledgerEntry.length, 3);
  });

  it("repeated scans after a FUNDED recovery write no duplicate events or ledger rows", async () => {
    const obligation = addObligation();
    addAttempt(obligation);
    const provider = providerFor("verified");

    await withProvider(provider.override, () => reconciliation.runReconciliationScan({ now: new Date() }));

    const eventsAfterFirst = db.financialEvent.length;
    const ledgerAfterFirst = db.ledgerEntry.length;
    // The seed wrote no initiation events, so the scan's payment_verified is
    // the only event.
    assert.equal(eventsAfterFirst, 1);
    assert.equal(ledgerAfterFirst, 3);

    // Second scan: the obligation is no longer PROCESSING → not scanned.
    const second = await withProvider(provider.override, () =>
      reconciliation.runReconciliationScan({ now: new Date() }),
    );

    assert.equal(second.stuckCount, 0);
    assert.equal(db.financialEvent.length, eventsAfterFirst);
    assert.equal(db.ledgerEntry.length, ledgerAfterFirst);
  });

  it("concurrent scans converge: the conditional FUNDED update arbitrates and no accounting row is duplicated", async () => {
    const obligation = addObligation();
    addAttempt(obligation);

    const providerA = providerFor("verified");
    const providerB = providerFor("verified");

    const [reportA, reportB] = await Promise.all([
      withProvider(providerA.override, () => reconciliation.runReconciliationScan({ now: new Date() })),
      withProvider(providerB.override, () => reconciliation.runReconciliationScan({ now: new Date() })),
    ]);

    // Both scans saw the stuck obligation and called the gate.
    assert.equal(reportA.funding.reverified, 1);
    assert.equal(reportB.funding.reverified, 1);

    // Exactly one winner transitioned; the loser replayed idempotently or
    // reported the concurrent move — either way exactly ONE accounting set.
    const outcomes = [...reportA.funding.outcomes, ...reportB.funding.outcomes];
    const funded = outcomes.filter((o) => o.outcome === "FUNDED");

    assert.ok(
      funded.length === 1 || funded.every((o) => o.code === undefined || o.code !== "INVALID_STATE"),
      "at most one scan settles the obligation",
    );

    assert.equal(obligation.status, "FUNDED");
    assert.equal(obligation.escrowFunded, true);
    assert.equal(db.financialEvent.filter((e) => e.eventType === "payment_verified").length, 1);
    assert.equal(db.ledgerEntry.filter((l) => l.entryType === "CHARGE").length, 1);
    assert.equal(db.ledgerEntry.filter((l) => l.entryType === "ESCROW_HOLD").length, 1);
    assert.equal(db.ledgerEntry.filter((l) => l.entryType === "PLATFORM_FEE").length, 1);
  });

  // -----------------------------------------------------------------------
  // Scan scoping
  // -----------------------------------------------------------------------

  it("does not prematurely reconcile a non-stale PROCESSING obligation", async () => {
    const obligation = addObligation({ updatedAt: new Date() }); // fresh
    addAttempt(obligation);
    const provider = providerFor("verified");

    const report = await withProvider(provider.override, () =>
      reconciliation.runReconciliationScan({
        now: new Date(),
        thresholdMinutes: 30,
      }),
    );

    assert.equal(report.stuckCount, 0);
    assert.equal(report.funding.reverified, 0);
    assert.equal(provider.callCount(), 0);
    assert.equal(obligation.status, "PROCESSING");
    assert.equal(db.ledgerEntry.length, 0);
  });

  it("leaves non-PROCESSING states untouched (PENDING_PAYMENT, FUNDED, FAILED, DISPUTED, CANCELLED, REFUND_PENDING)", async () => {
    const statuses = [
      "PENDING_PAYMENT",
      "FUNDED",
      "SETTLEMENT_PENDING",
      "RELEASED",
      "REFUND_PENDING",
      "REFUNDED",
      "FAILED",
      "DISPUTED",
      "CANCELLED",
    ];

    for (const status of statuses) {
      const obligation = addObligation({ status, updatedAt: new Date(Date.now() - 90 * 60 * 1000) });

      if (status === "PENDING_PAYMENT") {
        // No attempt for a never-initiated obligation.
      } else {
        addAttempt(obligation);
      }
    }

    const provider = providerFor("verified");

    const report = await withProvider(provider.override, () =>
      reconciliation.runReconciliationScan({ now: new Date() }),
    );

    assert.equal(report.stuckCount, 0);
    assert.equal(report.funding.reverified, 0);
    assert.equal(provider.callCount(), 0);

    for (const status of statuses) {
      const row = db.financialObligation.find((o) => o.status === status);

      assert.ok(row, `the ${status} row must exist`);
      assert.equal(row.status, status);
    }

    assert.equal(db.ledgerEntry.length, 0);
  });

  it("respects the configurable stale threshold and preserves the existing report shape (candidates + payouts)", async () => {
    const stale = addObligation({ updatedAt: new Date(Date.now() - 61 * 60 * 1000) });
    addAttempt(stale);

    const fresh = addObligation({ updatedAt: new Date(Date.now() - 10 * 60 * 1000) });
    addAttempt(fresh);

    const provider = providerFor("verified");

    const report = await withProvider(provider.override, () =>
      reconciliation.runReconciliationScan({ now: new Date(), thresholdMinutes: 60 }),
    );

    assert.equal(report.stuckCount, 1);
    assert.equal(report.candidates[0].obligationId, stale.id);
    // The recovered provider reference is the one already on the attempt row.
    assert.equal(report.candidates[0].providerReference, "access_code_6");
    assert.ok(report.candidates[0].ageMinutes >= 60);
    assert.equal(report.funding.reverified, 1);
    assert.equal(report.funding.outcomes[0].outcome, "FUNDED");
    assert.equal(fresh.status, "PROCESSING");

    // The Stage 14C payout half of the report is preserved.
    assert.ok("payouts" in report);
    assert.ok(Array.isArray(report.payouts.notes));
    assert.ok(typeof report.note === "string" && report.note.length > 0);
  });

  it("isolates candidates: a mix of eligible, attempt-less and failed-attempt rows is handled in one scan", async () => {
    const good = addObligation();
    addAttempt(good);

    const attemptless = addObligation();

    const failedAttempt = addObligation();
    addAttempt(failedAttempt, { providerStatus: "FAILED" });

    const provider = providerFor("verified");

    const report = await withProvider(provider.override, () =>
      reconciliation.runReconciliationScan({ now: new Date() }),
    );

    assert.equal(report.stuckCount, 3);
    assert.equal(report.funding.reverified, 1);
    assert.equal(report.funding.noAttempt, 1);
    assert.equal(report.funding.skippedFailedAttempt, 1);
    assert.equal(provider.callCount(), 1);

    assert.equal(good.status, "FUNDED");
    assert.equal(attemptless.status, "PROCESSING");
    assert.equal(failedAttempt.status, "PROCESSING");
  });

  // -----------------------------------------------------------------------
  // Direct-gate regression (reconciliation uses the existing service)
  // -----------------------------------------------------------------------

  it("reconciliation reuses the existing verification gate: a direct verifyAndSettleFunding call funds the same obligation idempotently", async () => {
    const obligation = addObligation();
    addAttempt(obligation);
    const provider = providerFor("verified");

    // First via reconciliation...
    await withProvider(provider.override, () => reconciliation.runReconciliationScan({ now: new Date() }));

    assert.equal(obligation.status, "FUNDED");

    // ...then directly through the same gate the webhook path uses — the
    // replay is a no-op (no duplicate ledger/event).
    const replay = await withProvider(provider.override, () =>
      verification.verifyAndSettleFunding(obligation.id as string),
    );

    assert.equal(replay.ok, true);

    if (replay.ok) {
      assert.equal(replay.status, "FUNDED");
      assert.equal(replay.idempotentReplay, true); // state already FUNDED → early no-op
    }

    assert.equal(db.financialEvent.filter((e) => e.eventType === "payment_verified").length, 1);
    assert.equal(db.ledgerEntry.length, 3);
  });
});

// ---------------------------------------------------------------------------
// Test helper: run the scan with the provider override wired into the
// verification gate's own test seam (production passes nothing).
// ---------------------------------------------------------------------------

async function withProvider<T>(
  override: VerifyOverride,
  run: () => Promise<T>,
): Promise<T> {
  // Route the gate's provider resolution through the test double.
  activeProvider = {
    verifyTransaction: (request: VerifyRequest) => override(request),
  };

  try {
    return await run();
  } finally {
    activeProvider = null;
  }
}
