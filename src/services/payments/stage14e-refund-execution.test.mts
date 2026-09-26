import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Stage 14E — refund execution tests (service + Paystack adapter).
 *
 * Pattern: the established in-memory Prisma stub (unique-constraint
 * simulation, transactional rollback) + module mocks registered BEFORE the
 * modules under test are imported (14B/14D convention).
 *
 * Pins the Stage 14E matrix:
 *
 *   Paystack adapter (POST /refund, documented API):
 *     - 200 + status:true + data.status "processed"  → processed
 *     - 200 + status:true + data.status "pending"    → pending (async API)
 *     - 200 + status:true + data.status "processing" → pending
 *     - HTTP 4xx / status:false / malformed body     → failed (explicit)
 *     - network error / timeout                      → pending (uncertainty)
 *     - never a fake success; only documented fields sent
 *
 *   Refund service authorization (14D boundary, unweakened):
 *     - unauthenticated / CREATOR / ADVERTISER → refused
 *     - SUPPORT without roster → refused; rostered SUPPORT → allowed
 *     - identity mismatch (session user ≠ actor.userId) → refused
 *     - roster revocation between calls → refused
 *
 *   State machine:
 *     - FUNDED → REFUND_PENDING (refund_requested event) → REFUNDED
 *       (refund_completed event + 3-line compensating ledger)
 *     - REFUNDED cannot be refunded again; invalid start states refused
 *     - dispute-frozen obligation cannot be refunded (freeze respected);
 *       explicit unfreeze then refund works
 *
 *   Safety gates:
 *     - settled/released milestone blocks; in-flight payout blocks;
 *       full amount only (no partial amount ever passed to the provider)
 *
 *   Provider outcomes:
 *     - processed → REFUNDED; failed → stays REFUND_PENDING (audited,
 *       no fake success); timeout/network uncertainty → stays REFUND_PENDING
 *
 *   14E SAFETY FIX — reconcile-before-re-post (POST /refund has NO client
 *   reference and is NOT idempotent):
 *     - an attempt row that predates the call is RECONCILED via
 *       getRefundStatus (safe GET) — NEVER re-POSTed blind; this recovers a
 *       crash between the provider POST and the local marker write (unposted
 *       rows reconcile by-transaction too);
 *     - P2002 on the attempt-row create (live concurrent claimant) → strict
 *       idempotent replay, ZERO provider calls for the loser;
 *     - pending/processing provider status → stay REFUND_PENDING, no POST;
 *     - processed provider status → local completion EXACTLY ONCE (no
 *       duplicate events/ledger on repeated reconciliations);
 *     - provider confirms no live refund → exactly ONE fresh POST;
 *     - lookup failure → FAIL CLOSED (RECONCILIATION_INCONCLUSIVE, no POST);
 *     - provider refund id (data.id) is persisted on the attempt row BEFORE
 *       any local finalization (crash-safe retry handle).
 *
 *   Accounting / idempotency:
 *     - exact three REFUND lines, correct directions/amounts/accounts;
 *       deterministic keys; duplicate request refused; replay no-op;
 *       no duplicate events/ledger rows; no CreatorPayout rows.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma stub (unique constraints + transactional rollback)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { id: string };

const db: Record<string, Row[]> = {
  user: [],
  campaignAgreement: [],
  financialObligation: [],
  financialEvent: [],
  ledgerEntry: [],
  paymentProviderTransaction: [],
  milestone: [],
  creatorPayout: [],
};

let nextId = 1;
const id = (prefix: string) => `${prefix}-${nextId++}`;

function resetDb(): void {
  for (const table of Object.keys(db)) {
    db[table] = [];
  }

  transactionWrites = [];
  failAttemptMetadataWrites = false;
}

/** When set, the attempt-row metadata write fails (DB crash after POST). */
let failAttemptMetadataWrites = false;

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
  user: {
    findUnique: async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
      const row = db.user.find((r) => r.id === args.where.id);

      if (!row) return null;

      if (args.select) {
        const projected: Row = { id: row.id };

        for (const key of Object.keys(args.select)) {
          if (args.select[key]) projected[key] = row[key];
        }

        return structuredClone(projected);
      }

      return structuredClone(row);
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
  milestone: {
    count: async (args: { where: Record<string, unknown> }) =>
      db.milestone.filter((m) => matches(m, args.where)).length,
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
      const row = db.paymentProviderTransaction.find((t) =>
        matches(
          { ...t, milestoneId: t.milestoneId ?? null },
          args.where,
        ),
      );

      return row ? structuredClone(row) : null;
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
      // Simulates a DB failure on the attempt-row metadata write (the
      // "provider accepted, then our DB failed" crash window).
      if (failAttemptMetadataWrites && args.data.metadata !== undefined) {
        throw new Error("injected attempt-metadata write failure");
      }

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
  creatorPayout: {
    findMany: async () => structuredClone(db.creatorPayout),
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
// Session seam (mirrors the real Auth.js JWT/session behavior)
// ---------------------------------------------------------------------------

type Role = "CREATOR" | "ADVERTISER" | "SUPPORT" | null;

let sessionRole: Role = null;
let sessionUserId: string | null = null;

function mockModule(specifier: string, exports: Record<string, unknown>): void {
  (mock.module as (spec: string, opts: Record<string, unknown>) => void)(
    specifier,
    { exports },
  );
}

mockModule("server-only", {});
mockModule("@/lib/prisma", { prisma: prismaStub as never });

mockModule("next/navigation", {
  redirect: (path: string) => {
    const error = new Error(`REDIRECTED:${path}`) as Error & { digest?: string };
    error.digest = `NEXT_REDIRECT;${path}`;
    throw error;
  },
});

mockModule("@/lib/auth", {
  auth: async () => {
    if (sessionRole === null || !sessionUserId) {
      return null;
    }

    return {
      user: {
        id: sessionUserId,
        role: sessionRole,
        name: "Test User",
        email: "user@example.com",
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Imports (AFTER module mocks are registered)
// ---------------------------------------------------------------------------

type RefundService = typeof import("@/services/payments/refund.service");
type PaystackProviderModule = typeof import("@/services/payments/paystack.provider");

let refundService: RefundService;
let providerModule: PaystackProviderModule;

const SUPPORT_USER = "user-support-1";
const CREATOR_USER = "user-creator-1";
const ADVERTISER_USER = "user-advertiser-1";
const ADV = "adv-profile-1";

function addRosterUser(userId: string): void {
  db.user.push({ id: userId, supportRosterMember: true } as Row);
}

function asSession(role: Role, userId: string | null): void {
  sessionRole = role;
  sessionUserId = userId;
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
    status: "FUNDED",
    obligationRef: `OBL-${id("ref").toUpperCase()}`,
    escrowFunded: true,
    dispute: false,
    providerReference: "access_code_1",
    ...overrides,
  };

  db.financialObligation.push(row);

  return row;
}

function addMilestone(overrides: Record<string, unknown> = {}): Row {
  const row: Row = {
    id: id("milestone"),
    agreementId: id("agr"),
    status: "CONFIRMED_RELEASE",
    creatorAmountMinor: 30000000n,
    currency: "NGN",
    ...overrides,
  };

  db.milestone.push(row);

  return row;
}

/** Drive one fresh FUNDED obligation to REFUNDED through the service. */
async function runToRefunded() {
  const obligation = addObligation();
  addRosterUser(SUPPORT_USER);
  asSession("SUPPORT", SUPPORT_USER);

  const result = await refundService.executeFullRefund(
    obligation.id as string,
    supportActor(),
    { providerOverride: fakeProvider(async () => ({ status: "processed", providerReference: "424245" })) as never },
  );

  assert.equal(result.ok, true);

  return obligation;
}

/** The sanctioned actor shape: derived server-side, never client input. */
function supportActor(userId: string = SUPPORT_USER) {
  return { authenticated: true, userId, source: "test" };
}

/** A provider test double wired into the service's test seam. */
function fakeProvider(
  behavior: () => Promise<{ status: "pending" | "processed" | "failed"; providerReference: string | null; reason?: string }>,
  statusBehavior?: (request: { providerRefundId: string | null; chargeReference: string }) => Promise<
    | { status: "pending" | "processed" | "failed"; providerRefundId: string | null }
    | { status: "unknown"; reason: string }
  >,
) {
  let calls = 0;
  let lastRequest: Record<string, unknown> | null = null;
  let statusCalls = 0;
  let lastStatusRequest: Record<string, unknown> | null = null;

  return {
    callCount: () => calls,
    lastRequest: () => lastRequest,
    statusCallCount: () => statusCalls,
    lastStatusRequest: () => lastStatusRequest,
    createRefund: async (request: Record<string, unknown>) => {
      calls += 1;
      lastRequest = request;

      return behavior();
    },
    getRefundStatus: async (request: { providerRefundId: string | null; chargeReference: string }) => {
      statusCalls += 1;
      lastStatusRequest = request;

      // Fail-safe default: an unspecified lookup reports an in-flight refund
      // (never licenses a re-POST).
      return statusBehavior
        ? statusBehavior(request)
        : ({ status: "pending", providerRefundId: null } as const);
    },
  };
}

describe("Stage 14E — refund execution", () => {
  before(async () => {
    refundService = await import("@/services/payments/refund.service");
    providerModule = await import("@/services/payments/paystack.provider");
  });

  beforeEach(() => {
    resetDb();
    sessionRole = null;
    sessionUserId = null;
  });

  // -------------------------------------------------------------------------
  // Paystack adapter — POST /refund (documented API)
  // -------------------------------------------------------------------------

  describe("Paystack adapter createRefund", () => {
    const baseRequest = {
      obligationId: "obl-1",
      providerReference: "access_code_1",
      amountMinor: 103500000n,
      currency: "NGN",
      reference: "ref-obl-1",
    };

    function providerWithFetch(fetchImpl: (
      url: string,
      init: { method: string; headers: Record<string, string>; body?: string },
    ) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>) {
      return new providerModule.PaystackProvider(
        { secretKey: "sk_test_abc", baseUrl: "http://paystack.test" },
        fetchImpl,
        async () => null,
      );
    }

    it("maps a processed refund to the processed outcome (provider's own marker)", async () => {
      let capturedBody: string | undefined;
      let capturedPath: string | undefined;

      const provider = providerWithFetch(async (url: string, init: { method: string; body?: string }) => {
        capturedPath = url;
        capturedBody = init.body;

        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              status: true,
              message: "Refund has been queued for processing",
              data: { id: 3018284, status: "processed", amount: 103500000, currency: "NGN" },
            }),
        };
      });

      const result = await provider.createRefund(baseRequest);

      assert.equal(result.status, "processed");
      assert.equal(result.providerReference, "3018284");
      assert.ok(capturedPath!.endsWith("/refund"));
      assert.ok(capturedBody!.includes("\"transaction\":\"access_code_1\""));
      assert.ok(capturedBody!.includes("\"amount\":\"103500000\""));
      // Only documented fields are sent — no invented reference field.
      assert.ok(!capturedBody!.includes("reference"));
    });

    it("maps the documented queued (pending) create response to pending — the API is asynchronous", async () => {
      const provider = providerWithFetch(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            status: true,
            message: "Refund has been queued for processing",
            data: { id: 3018285, status: "pending", amount: 103500000, currency: "NGN" },
          }),
      }));

      const result = await provider.createRefund(baseRequest);

      assert.equal(result.status, "pending");
      assert.equal(result.providerReference, "3018285");
    });

    it("maps an in-flight (processing) provider status to pending", async () => {
      const provider = providerWithFetch(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            status: true,
            message: "Refund has been queued for processing",
            data: { id: 3018286, status: "processing" },
          }),
      }));

      assert.equal((await provider.createRefund(baseRequest)).status, "pending");
    });

    it("maps a provider rejection (HTTP 4xx / status:false) to an explicit failure", async () => {
      const provider = providerWithFetch(async () => ({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            status: false,
            message: "Transaction has already been fully refunded",
          }),
      }));

      const result = await provider.createRefund(baseRequest);

      assert.equal(result.status, "failed");
      assert.equal(result.providerReference, null);
      assert.match(result.status === "failed" ? result.reason : "", /already been fully refunded/);
    });

    it("maps a malformed provider body to failed (explicit, never success)", async () => {
      const provider = providerWithFetch(async () => ({
        ok: true,
        status: 200,
        text: async () => "not json at all",
      }));

      assert.equal((await provider.createRefund(baseRequest)).status, "failed");
    });

    it("maps a network failure to pending — uncertainty is never failure", async () => {
      const provider = providerWithFetch(async () => {
        throw new Error("network unreachable");
      });

      const result = await provider.createRefund(baseRequest);

      assert.equal(result.status, "pending");
      assert.equal(result.providerReference, "ref-obl-1");
    });

    it("maps a timeout to pending — uncertainty is never failure", async () => {
      const provider = providerWithFetch(async () => {
        const error = new Error("timed out");

        error.name = "PaystackTimeoutError";
        throw error;
      });

      assert.equal((await provider.createRefund(baseRequest)).status, "pending");
    });
  });

  // -------------------------------------------------------------------------
  // Paystack adapter — getRefundStatus (the 14E reconciliation read primitive)
  // -------------------------------------------------------------------------
  // The service's reconcile-before-replay rule leans entirely on this mapping:
  // "processed" licenses ONE local finalization, "failed" (or an empty list)
  // licenses ONE fresh POST, "pending" says stay, and ANY unanswerable lookup
  // must come back "unknown" so the caller fails closed instead of re-POSTing.

  describe("Paystack adapter getRefundStatus", () => {
    function providerWithFetch(fetchImpl: (
      url: string,
      init: { method: string; headers: Record<string, string>; body?: string },
    ) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>) {
      return new providerModule.PaystackProvider(
        { secretKey: "sk_test_abc", baseUrl: "http://paystack.test" },
        fetchImpl,
        async () => null,
      );
    }

    const requestWithId = {
      providerRefundId: "3018284",
      chargeReference: "access_code_1",
    };

    const requestWithoutId = {
      providerRefundId: null,
      chargeReference: "access_code_1",
    };

    it("resolves a persisted refund id to processed", async () => {
      const seenPaths: string[] = [];

      const provider = providerWithFetch(async (url: string) => {
        seenPaths.push(url);

        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              status: true,
              message: "Refund fetched",
              data: { id: 3018284, status: "processed", amount: 103500000, currency: "NGN" },
            }),
        };
      });

      const result = await provider.getRefundStatus(requestWithId);

      assert.deepEqual(result, { status: "processed", providerRefundId: "3018284" });
      // Targeted by-id lookup only: no widening search past a definitive answer.
      assert.equal(seenPaths.length, 1);
      assert.ok(seenPaths[0]!.includes("/refund/3018284"));
    });

    it("maps pending/processing by-id statuses to pending", async () => {
      for (const rawStatus of ["pending", "processing"]) {
        const provider = providerWithFetch(async () => ({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              status: true,
              message: "Refund fetched",
              data: { id: 3018285, status: rawStatus },
            }),
        }));

        const result = await provider.getRefundStatus(requestWithId);

        assert.deepEqual(result, { status: "pending", providerRefundId: "3018285" }, rawStatus);
      }
    });

    it("fails closed as unknown when the by-id lookup errors — no list fallback", async () => {
      const seenPaths: string[] = [];

      const provider = providerWithFetch(async (url: string) => {
        seenPaths.push(url);

        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              status: false,
              message: "Refund not found",
            }),
        };
      });

      const result = await provider.getRefundStatus(requestWithId);

      assert.equal(result.status, "unknown");
      assert.ok(
        result.status === "unknown" && result.reason.length > 0,
        "unknown carries an operator-facing reason",
      );
      // Only the by-id GET was attempted: a failed targeted lookup must NOT
      // silently widen to the list endpoint, whose answer could license a
      // re-POST from evidence the targeted call never endorsed.
      assert.equal(seenPaths.length, 1);
      assert.ok(seenPaths[0]!.includes("/refund/3018284"));
    });

    it("maps a network failure on the by-id lookup to unknown (never failed)", async () => {
      const provider = providerWithFetch(async () => {
        throw new Error("network unreachable");
      });

      const result = await provider.getRefundStatus(requestWithId);

      // An unanswerable lookup must never license a re-POST of the
      // money-moving endpoint.
      assert.equal(result.status, "unknown");
    });

    it("lists by charge reference when no refund id was persisted; empty list → failed", async () => {
      const seenPaths: string[] = [];

      const provider = providerWithFetch(async (url: string) => {
        seenPaths.push(url);

        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              status: true,
              message: "Refunds fetched",
              data: [],
            }),
        };
      });

      const result = await provider.getRefundStatus(requestWithoutId);

      // Provider confirms no refund exists — the only state that licenses ONE
      // fresh POST on the service side.
      assert.deepEqual(result, { status: "failed", providerRefundId: null });
      assert.equal(seenPaths.length, 1);
      assert.ok(seenPaths[0]!.includes("/refund?transaction=access_code_1"));
    });

    it("aggregate over a mixed list is the SAFEST outcome: pending beats processed", async () => {
      const provider = providerWithFetch(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            status: true,
            message: "Refunds fetched",
            data: [
              { id: 3018290, status: "processed" },
              { id: 3018291, status: "pending" },
            ],
          }),
      }));

      const result = await provider.getRefundStatus(requestWithoutId);

      // Never re-POST past an in-flight refund.
      assert.deepEqual(result, { status: "pending", providerRefundId: "3018291" });
    });

    it("aggregate over an all-processed list reports processed with the provider id", async () => {
      const provider = providerWithFetch(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            status: true,
            message: "Refunds fetched",
            data: [
              { id: 3018292, status: "processed" },
              { id: 3018293, status: "processed" },
            ],
          }),
      }));

      const result = await provider.getRefundStatus(requestWithoutId);

      assert.deepEqual(result, { status: "processed", providerRefundId: "3018292" });
    });

    it("maps a malformed body to unknown (never to a re-POST-licensing answer)", async () => {
      const provider = providerWithFetch(async () => ({
        ok: true,
        status: 200,
        text: async () => "not json at all",
      }));

      const result = await provider.getRefundStatus(requestWithoutId);

      assert.equal(result.status, "unknown");
    });
  });

  // -------------------------------------------------------------------------
  // Authorization (the 14D boundary, unweakened)
  // -------------------------------------------------------------------------

  describe("authorization", () => {
    it("refuses an unauthenticated actor", async () => {
      const obligation = addObligation();
      const provider = fakeProvider(async () => ({ status: "processed", providerReference: "1" }));

      const result = await refundService.executeFullRefund(
        obligation.id as string,
        { authenticated: false, userId: SUPPORT_USER, source: "test" },
        { providerOverride: provider as never },
      );

      assert.equal(result.ok, false);
      assert.equal(result.ok ? "" : result.code, "UNAUTHORIZED");
      assert.equal(provider.callCount(), 0);
      assert.equal(obligation.status, "FUNDED");
    });

    it("refuses a CREATOR session (even a roster-flagged one)", async () => {
      const obligation = addObligation();
      addRosterUser(CREATOR_USER);
      asSession("CREATOR", CREATOR_USER);

      const result = await refundService.executeFullRefund(
        obligation.id as string,
        supportActor(CREATOR_USER),
        { providerOverride: fakeProvider(async () => ({ status: "processed", providerReference: "1" })) as never },
      );

      assert.equal(result.ok, false);
      assert.equal(result.ok ? "" : result.code, "UNAUTHORIZED");
      assert.equal(obligation.status, "FUNDED");
    });

    it("refuses an ADVERTISER session", async () => {
      const obligation = addObligation();
      asSession("ADVERTISER", ADVERTISER_USER);

      const result = await refundService.executeFullRefund(
        obligation.id as string,
        supportActor(ADVERTISER_USER),
        { providerOverride: fakeProvider(async () => ({ status: "processed", providerReference: "1" })) as never },
      );

      assert.equal(result.ok, false);
      assert.equal(result.ok ? "" : result.code, "UNAUTHORIZED");
    });

    it("refuses a SUPPORT session without roster membership (empty roster fail-closed)", async () => {
      const obligation = addObligation();
      asSession("SUPPORT", SUPPORT_USER);

      const result = await refundService.executeFullRefund(
        obligation.id as string,
        supportActor(),
        { providerOverride: fakeProvider(async () => ({ status: "processed", providerReference: "1" })) as never },
      );

      assert.equal(result.ok, false);
      assert.equal(result.ok ? "" : result.code, "UNAUTHORIZED");
      assert.equal(obligation.status, "FUNDED");
    });

    it("allows a rostered SUPPORT session", async () => {
      const obligation = addObligation();
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      const result = await refundService.executeFullRefund(
        obligation.id as string,
        supportActor(),
        { providerOverride: fakeProvider(async () => ({ status: "pending", providerReference: "9001" })) as never },
      );

      assert.equal(result.ok, true);
      assert.equal(result.ok ? result.status : "", "REFUND_PENDING");
    });

    it("refuses a SUPPORT session acting as ANOTHER user (identity mismatch)", async () => {
      const obligation = addObligation();
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      // The actor claims a different identity than the live session — refused.
      const result = await refundService.executeFullRefund(
        obligation.id as string,
        supportActor("user-support-IMPERSONATOR"),
        { providerOverride: fakeProvider(async () => ({ status: "processed", providerReference: "1" })) as never },
      );

      assert.equal(result.ok, false);
      assert.equal(result.ok ? "" : result.code, "UNAUTHORIZED");
      assert.equal(obligation.status, "FUNDED");
    });

    it("refuses after roster revocation (fresh-DB check on every call)", async () => {
      const obligation = addObligation();
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      // Authorized once (pending outcome keeps the obligation REFUND_PENDING)…
      const first = await refundService.executeFullRefund(
        obligation.id as string,
        supportActor(),
        { providerOverride: fakeProvider(async () => ({ status: "pending", providerReference: "9002" })) as never },
      );

      assert.equal(first.ok, true);

      // …then revoked — the next call is refused.
      const row = db.user.find((r) => r.id === SUPPORT_USER)!;
      row.supportRosterMember = false;

      const second = await refundService.executeFullRefund(
        obligation.id as string,
        supportActor(),
        { providerOverride: fakeProvider(async () => ({ status: "processed", providerReference: "9003" })) as never },
      );

      assert.equal(second.ok, false);
      assert.equal(second.ok ? "" : second.code, "UNAUTHORIZED");
      assert.equal(obligation.status, "REFUND_PENDING");
    });
  });

  // -------------------------------------------------------------------------
  // State machine + safety gates
  // -------------------------------------------------------------------------

  describe("state machine and safety gates", () => {
    it("drives FUNDED → REFUND_PENDING → REFUNDED with both events", async () => {
      const obligation = addObligation();
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      const result = await refundService.executeFullRefund(
        obligation.id as string,
        supportActor(),
        { providerOverride: fakeProvider(async () => ({ status: "processed", providerReference: "424242" })) as never },
      );

      assert.equal(result.ok, true);
      assert.equal(result.ok ? result.status : "", "REFUNDED");
      assert.equal(obligation.status, "REFUNDED");

      const eventTypes = db.financialEvent.map((e) => e.eventType);
      assert.ok(eventTypes.includes("refund_requested"));
      assert.ok(eventTypes.includes("refund_completed"));
    });

    it("refuses an obligation in a non-refundable state (PENDING_PAYMENT, RELEASED, REFUNDED…)", async () => {
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      for (const status of ["PENDING_PAYMENT", "PROCESSING", "RELEASED", "REFUNDED", "FAILED", "CANCELLED", "DISPUTED"]) {
        const obligation = addObligation({ status, providerReference: "access_code_x" });

        const result = await refundService.executeFullRefund(
          obligation.id as string,
          supportActor(),
          { providerOverride: fakeProvider(async () => ({ status: "processed", providerReference: "1" })) as never },
        );

        assert.equal(result.ok, false, `status ${status} must be refused`);
        assert.equal(result.ok ? "" : result.code, "INVALID_STATE");
        assert.equal(obligation.status, status, `state must be untouched for ${status}`);
      }
    });

    it("refuses a DISPUTED-frozen obligation and never bypasses the freeze", async () => {
      const obligation = addObligation({ dispute: true });
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      const result = await refundService.executeFullRefund(
        obligation.id as string,
        supportActor(),
        { providerOverride: fakeProvider(async () => ({ status: "processed", providerReference: "1" })) as never },
      );

      assert.equal(result.ok, false);
      assert.equal(result.ok ? "" : result.code, "DISPUTE_FROZEN");
      assert.equal(obligation.status, "FUNDED");

      const eventTypes = db.financialEvent.map((e) => e.eventType);
      assert.ok(!eventTypes.includes("refund_requested"));
    });

    it("allows a refund after an explicit unfreeze (dispute overlay respected, not bypassed)", async () => {
      // The machine's DISPUTED → REFUND_PENDING edge exists, but 14E's policy
      // requires the operator to lift the freeze first: DISPUTED is not a
      // refund-requestable state, while FUNDED (post-unfreeze) is.
      const obligation = addObligation({ status: "FUNDED", dispute: true });
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      // Operator lifts the freeze via the EXISTING 14D-authorized seam.
      const disputeService = await import("@/services/payments/dispute.service");
      const unfreeze = await disputeService.setDisputeFreeze(
        obligation.id as string,
        false,
        { authenticated: true, userId: SUPPORT_USER, source: "test" },
        "resolved — refund approved",
      );

      assert.equal(unfreeze.ok, true);
      assert.equal(obligation.dispute, false);

      const result = await refundService.executeFullRefund(
        obligation.id as string,
        supportActor(),
        { providerOverride: fakeProvider(async () => ({ status: "processed", providerReference: "424243" })) as never },
      );

      assert.equal(result.ok, true);
      assert.equal(result.ok ? result.status : "", "REFUNDED");
    });

    it("hard-blocks when any milestone of the agreement is settled/released", async () => {
      const agreementId = id("agr");
      const obligation = addObligation({ agreementId });
      addMilestone({ agreementId, status: "RELEASED" });
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      const result = await refundService.executeFullRefund(
        obligation.id as string,
        supportActor(),
        { providerOverride: fakeProvider(async () => ({ status: "processed", providerReference: "1" })) as never },
      );

      assert.equal(result.ok, false);
      assert.equal(result.ok ? "" : result.code, "MILESTONE_SETTLED");
      assert.equal(obligation.status, "FUNDED");
    });

    it("hard-blocks when a payout/transfer attempt is in flight", async () => {
      const obligation = addObligation();
      db.paymentProviderTransaction.push({
        id: id("tx"),
        obligationId: obligation.id,
        milestoneId: id("milestone"),
        provider: "paystack",
        providerReference: "mpo-x:a1",
        providerStatus: "PENDING",
        amountMinor: 30000000n,
        currency: "NGN",
      } as Row);
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      const result = await refundService.executeFullRefund(
        obligation.id as string,
        supportActor(),
        { providerOverride: fakeProvider(async () => ({ status: "processed", providerReference: "1" })) as never },
      );

      assert.equal(result.ok, false);
      assert.equal(result.ok ? "" : result.code, "PAYOUT_IN_FLIGHT");
      assert.equal(obligation.status, "FUNDED");
    });

    it("sends the EXACT frozen advertiser total to the provider — full refunds only", async () => {
      const obligation = addObligation();
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      const provider = fakeProvider(async () => ({ status: "pending", providerReference: "1" }));

      await refundService.executeFullRefund(
        obligation.id as string,
        supportActor(),
        { providerOverride: provider as never },
      );

      const request = provider.lastRequest() as { amountMinor: bigint; currency: string; providerReference: string; reference: string };

      assert.equal(request.amountMinor, obligation.advertiserTotalMinor);
      assert.equal(request.amountMinor, 103500000n);
      assert.equal(request.currency, obligation.currency);
      assert.equal(request.providerReference, obligation.providerReference);
      assert.equal(request.reference, `ref-${obligation.id as string}`);
    });

    it("refuses when the obligation carries no provider charge reference", async () => {
      const obligation = addObligation({ providerReference: null });
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      const result = await refundService.executeFullRefund(
        obligation.id as string,
        supportActor(),
        { providerOverride: fakeProvider(async () => ({ status: "processed", providerReference: "1" })) as never },
      );

      assert.equal(result.ok, false);
      assert.equal(result.ok ? "" : result.code, "PROVIDER_REFERENCE_MISSING");
      assert.equal(obligation.status, "FUNDED");
    });

    it("refuses when no payment provider is configured", async () => {
      const obligation = addObligation();
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      // No providerOverride and no configured global provider.
      const result = await refundService.executeFullRefund(obligation.id as string, supportActor());

      assert.equal(result.ok, false);
      assert.equal(result.ok ? "" : result.code, "PROVIDER_UNCONFIGURED");
    });
  });

  // -------------------------------------------------------------------------
  // Provider outcomes
  // -------------------------------------------------------------------------

  describe("provider outcome handling", () => {
    it("stays REFUND_PENDING on provider pending (never falsely refunded)", async () => {
      const obligation = addObligation();
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      const result = await refundService.executeFullRefund(
        obligation.id as string,
        supportActor(),
        { providerOverride: fakeProvider(async () => ({ status: "pending", providerReference: "9001" })) as never },
      );

      assert.equal(result.ok, true);
      assert.equal(result.ok ? result.status : "", "REFUND_PENDING");
      assert.equal(obligation.status, "REFUND_PENDING");

      const eventTypes = db.financialEvent.map((e) => e.eventType);
      assert.ok(!eventTypes.includes("refund_completed"));
      assert.equal(db.ledgerEntry.length, 0);
    });

    it("refuses on provider failure and stays REFUND_PENDING with an audited outcome (no fake success)", async () => {
      const obligation = addObligation();
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      const result = await refundService.executeFullRefund(
        obligation.id as string,
        supportActor(),
        { providerOverride: fakeProvider(async () => ({ status: "failed", providerReference: null, reason: "Paystack rejected the refund." })) as never },
      );

      assert.equal(result.ok, false);
      assert.equal(result.ok ? "" : result.code, "PROVIDER_FAILED");
      assert.equal(obligation.status, "REFUND_PENDING"); // NOT refunded, not silently reverted
      assert.equal(db.ledgerEntry.length, 0);

      const failedAudit = db.financialEvent.find(
        (e) => (e.metadata as { kind?: string })?.kind === "refunds_failed",
      );

      assert.ok(failedAudit, "the failed outcome must be audited");
    });

    // -----------------------------------------------------------------------
    // 14E SAFETY FIX — reconcile-before-re-post regression matrix
    // -----------------------------------------------------------------------

    it("SAFETY: provider accepted + DB failure + retry → NO second provider POST (reconciles instead)", async () => {
      const obligation = addObligation();
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      let postCalls = 0;

      const provider = fakeProvider(
        async () => {
          postCalls += 1;

          // The provider ACCEPTS the refund (queued) and returns its id —
          // then our attempt-metadata write fails (the crash window).
          return { status: "pending", providerReference: "3018290" };
        },
        async () => ({ status: "processed", providerRefundId: "3018290" }),
      );

      const attemptCreator = prismaStub.paymentProviderTransaction as {
        create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
      };
      const realCreate = attemptCreator.create.bind(prismaStub.paymentProviderTransaction);

      (prismaStub.paymentProviderTransaction as unknown as {
        create: typeof realCreate;
      }).create = async (args: { data: Record<string, unknown> }) => {
        const row = await realCreate(args); // attempt row lands

        failAttemptMetadataWrites = true; // then the DB dies before the marker

        return row;
      };

      try {
        const first = await refundService.executeFullRefund(obligation.id as string, supportActor(), {
          providerOverride: provider as never,
        });

        // The POST landed provider-side; the marker write failed silently.
        assert.equal(first.ok, true);
        assert.equal(first.ok ? first.status : "", "REFUND_PENDING");
        assert.equal(postCalls, 1);
        assert.equal(provider.statusCallCount(), 0);

        // --- RETRY: the DB is back. The attempt row exists WITHOUT a posted
        // marker (the crash ate it) — the P2002 adoption path MUST reconcile
        // instead of re-POSTing.
        failAttemptMetadataWrites = false;

        const second = await refundService.executeFullRefund(obligation.id as string, supportActor(), {
          providerOverride: provider as never,
        });

        assert.equal(second.ok, true);
        assert.equal(second.ok ? second.status : "", "REFUNDED");
        assert.equal(second.ok ? second.providerRefundId : "", "3018290");

        // THE INVARIANT: exactly ONE provider POST across both attempts.
        assert.equal(postCalls, 1);
        assert.ok(provider.statusCallCount() >= 1, "the retry must reconcile via getRefundStatus");
        assert.equal(obligation.status, "REFUNDED");

        // The refund id learned from the lookup is persisted on the row.
        const attempt = db.paymentProviderTransaction.find(
          (t) => t.providerReference === `ref-${obligation.id as string}`,
        );

        assert.equal((attempt!.metadata as { providerRefundId?: string }).providerRefundId, "3018290");
      } finally {
        (prismaStub.paymentProviderTransaction as unknown as {
          create: typeof realCreate;
        }).create = realCreate;
      }
    });

    it("SAFETY: pending/processing provider refund → retry reconciles, stays REFUND_PENDING, NO second POST", async () => {
      const obligation = addObligation();
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      let postCalls = 0;

      const provider = fakeProvider(
        async () => {
          postCalls += 1;

          return { status: "pending", providerReference: "3018291" };
        },
        async () => ({ status: "pending", providerRefundId: "3018291" }),
      );

      // First attempt: queued provider-side.
      const first = await refundService.executeFullRefund(obligation.id as string, supportActor(), {
        providerOverride: provider as never,
      });

      assert.equal(first.ok, true);
      assert.equal(first.ok ? first.status : "", "REFUND_PENDING");
      assert.equal(postCalls, 1);

      // Retry while the provider still reports pending/processing.
      const second = await refundService.executeFullRefund(obligation.id as string, supportActor(), {
        providerOverride: provider as never,
      });

      assert.equal(second.ok, true);
      assert.equal(second.ok ? second.status : "", "REFUND_PENDING");
      assert.equal(second.ok ? second.idempotentReplay : "", true);
      assert.equal(second.ok ? second.providerRefundId : "", "3018291");

      // Still exactly ONE POST — reconciliation, not re-creation.
      assert.equal(postCalls, 1);
      assert.equal(provider.statusCallCount(), 1);
      assert.equal(obligation.status, "REFUND_PENDING");
      assert.ok(!db.financialEvent.some((e) => e.eventType === "refund_completed"));
      assert.equal(db.ledgerEntry.length, 0);
    });

    it("SAFETY: provider processed → retry completes locally (transition + ledger + event)", async () => {
      const obligation = addObligation();
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      const provider = fakeProvider(
        async () => ({ status: "pending", providerReference: "3018292" }),
        async () => ({ status: "processed", providerRefundId: "3018292" }),
      );

      const first = await refundService.executeFullRefund(obligation.id as string, supportActor(), {
        providerOverride: provider as never,
      });

      assert.equal(first.ok, true);
      assert.equal(first.ok ? first.status : "", "REFUND_PENDING");

      const second = await refundService.executeFullRefund(obligation.id as string, supportActor(), {
        providerOverride: provider as never,
      });

      assert.equal(second.ok, true);
      assert.equal(second.ok ? second.status : "", "REFUNDED");
      assert.equal(obligation.status, "REFUNDED");
      assert.equal(provider.callCount(), 1, "no second POST — completion came from provider evidence");

      const eventTypes = db.financialEvent.map((e) => e.eventType);

      assert.ok(eventTypes.includes("refund_completed"));
      assert.equal(db.ledgerEntry.filter((l) => l.entryType === "REFUND").length, 3);
    });

    it("SAFETY: no provider refund exists → exactly ONE fresh POST after the lookup", async () => {
      const obligation = addObligation();
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      let postCalls = 0;

      const provider = fakeProvider(
        async () => {
          postCalls += 1;

          return { status: "pending", providerReference: "3018293" };
        },
        async () => ({ status: "failed", providerRefundId: null }), // provider: no refund exists
      );

      const first = await refundService.executeFullRefund(obligation.id as string, supportActor(), {
        providerOverride: provider as never,
      });

      assert.equal(first.ok, true);
      assert.equal(postCalls, 1);

      // The lookup confirmed no live refund — the retry issues exactly ONE
      // fresh POST (never zero-and-stuck, never two).
      const second = await refundService.executeFullRefund(obligation.id as string, supportActor(), {
        providerOverride: provider as never,
      });

      assert.equal(second.ok, true);
      assert.equal(second.ok ? second.status : "", "REFUND_PENDING");
      assert.equal(postCalls, 2, "exactly one fresh POST after the provider confirmed none exists");
      assert.equal(provider.statusCallCount(), 1);
      assert.equal(obligation.status, "REFUND_PENDING");
    });

    it("SAFETY: P2002 on the attempt-row create → strict idempotent replay, NO provider call for the loser", async () => {
      const obligation = addObligation();
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      let postCalls = 0;
      let statusCalls = 0;

      const provider = {
        callCount: () => postCalls,
        statusCallCount: () => statusCalls,
        createRefund: async () => {
          postCalls += 1;

          return { status: "pending", providerReference: "3018294" } as const;
        },
        getRefundStatus: async () => {
          statusCalls += 1;

          return { status: "pending", providerRefundId: "3018294" } as const;
        },
      };

      // Two concurrent calls on a FUNDED obligation: one wins the attempt-row
      // create and POSTs; the loser's create throws P2002 — it must REPLAY
      // (REFUND_PENDING, idempotentReplay) and NEVER touch the provider.
      const outcomes = await Promise.all([
        refundService.executeFullRefund(obligation.id as string, supportActor(), {
          providerOverride: provider as never,
        }),
        refundService.executeFullRefund(obligation.id as string, supportActor(), {
          providerOverride: provider as never,
        }),
      ]);

      assert.ok(outcomes.every((r) => r.ok), "both calls converge without errors");

      const replays = outcomes.filter((r) => r.ok && r.idempotentReplay);

      assert.equal(replays.length, 1, "exactly one loser replays");
      assert.equal(replays[0]!.ok ? replays[0]!.status : "", "REFUND_PENDING");
      assert.equal(postCalls, 1, "the loser never POSTs on top of the winner's claim");
      assert.equal(statusCalls, 0, "the loser never reconciles either — strict replay");
      assert.equal(db.financialEvent.filter((e) => e.eventType === "refund_requested").length, 1);
    });

    it("SAFETY: repeated processed reconciliation → no duplicate events/ledger (idempotent completion)", async () => {
      const obligation = addObligation();
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      const provider = fakeProvider(
        async () => ({ status: "pending", providerReference: "3018295" }),
        async () => ({ status: "processed", providerRefundId: "3018295" }),
      );

      await refundService.executeFullRefund(obligation.id as string, supportActor(), {
        providerOverride: provider as never,
      });

      const firstCompletion = await refundService.executeFullRefund(obligation.id as string, supportActor(), {
        providerOverride: provider as never,
      });

      assert.equal(firstCompletion.ok, true);
      assert.equal(firstCompletion.ok ? firstCompletion.status : "", "REFUNDED");

      const eventsAfterFirst = db.financialEvent.length;
      const ledgerAfterFirst = db.ledgerEntry.length;

      // Repeated reconciliation AFTER completion: the REFUNDED state refuses
      // re-entry — nothing may be written twice.
      const replay = await refundService.executeFullRefund(obligation.id as string, supportActor(), {
        providerOverride: provider as never,
      });

      assert.equal(replay.ok, false);
      assert.equal(replay.ok ? "" : replay.code, "INVALID_STATE");
      assert.equal(db.financialEvent.length, eventsAfterFirst);
      assert.equal(db.ledgerEntry.length, ledgerAfterFirst);
      assert.equal(db.ledgerEntry.filter((l) => l.entryType === "REFUND").length, 3);
      assert.equal(provider.callCount(), 1);
    });

    it("SAFETY: provider lookup failure → FAIL CLOSED (no POST, explicit inconclusive code)", async () => {
      const obligation = addObligation();
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      let postCalls = 0;

      const provider = fakeProvider(
        async () => {
          postCalls += 1;

          return { status: "pending", providerReference: "3018296" };
        },
        async () => ({ status: "unknown", reason: "provider unreachable" }),
      );

      const first = await refundService.executeFullRefund(obligation.id as string, supportActor(), {
        providerOverride: provider as never,
      });

      assert.equal(first.ok, true);
      assert.equal(postCalls, 1);

      const second = await refundService.executeFullRefund(obligation.id as string, supportActor(), {
        providerOverride: provider as never,
      });

      assert.equal(second.ok, false);
      assert.equal(second.ok ? "" : second.code, "RECONCILIATION_INCONCLUSIVE");
      assert.equal(postCalls, 1, "an unanswerable lookup must never license a re-POST");
      assert.equal(provider.statusCallCount(), 1);
      assert.equal(obligation.status, "REFUND_PENDING");
    });

    it("SAFETY: concurrent duplicate calls → exactly one POST and one logical refund in the journal", async () => {
      const obligation = addObligation();
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      let postCalls = 0;

      const provider = fakeProvider(
        async () => {
          postCalls += 1;

          return { status: "pending", providerReference: "3018297" };
        },
        async () => ({ status: "processed", providerRefundId: "3018297" }),
      );

      const outcomes = await Promise.all([
        refundService.executeFullRefund(obligation.id as string, supportActor(), {
          providerOverride: provider as never,
        }),
        refundService.executeFullRefund(obligation.id as string, supportActor(), {
          providerOverride: provider as never,
        }),
      ]);

      // Winner posts once; the loser adopts the row via P2002 → strict
      // replay (no provider calls). The journal keeps exactly one logical
      // refund request.
      assert.ok(postCalls === 1, `expected exactly one POST, got ${postCalls}`);
      assert.ok(outcomes.every((r) => r.ok || r.code !== "PROVIDER_FAILED"));
      assert.equal(db.financialEvent.filter((e) => e.eventType === "refund_requested").length, 1);
    });

    it("records the Paystack refund id (data.id) on the attempt row BEFORE completion", async () => {
      const obligation = addObligation();
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      await refundService.executeFullRefund(obligation.id as string, supportActor(), {
        providerOverride: fakeProvider(async () => ({ status: "processed", providerReference: "424249" })) as never,
      });

      const attempt = db.paymentProviderTransaction.find(
        (t) => t.providerReference === `ref-${obligation.id as string}`,
      );

      assert.ok(attempt);
      assert.equal((attempt!.metadata as { kind?: string }).kind, "refund_posted");
      assert.equal((attempt!.metadata as { providerRefundId?: string }).providerRefundId, "424249");
      assert.equal(attempt!.providerStatus, "SUCCEEDED");
    });

    it("retries converge: an outstanding REFUND_PENDING settles through provider evidence, never a re-POST", async () => {
      const obligation = addObligation();
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      let postCalls = 0;

      const provider = fakeProvider(
        async () => {
          postCalls += 1;

          // First attempt: uncertain (queued) → stays REFUND_PENDING.
          return { status: "pending", providerReference: "9001" };
        },
        async (request) => {
          // The retry reconciles the SAME posted refund by its persisted id.
          assert.equal(request.providerRefundId, "9001");

          return { status: "processed", providerRefundId: "9001" };
        },
      );

      const first = await refundService.executeFullRefund(
        obligation.id as string,
        supportActor(),
        { providerOverride: provider as never },
      );

      assert.equal(first.ok, true);
      assert.equal(postCalls, 1);

      // Retry: reconciliation reports processed → REFUNDED with NO second POST.
      const second = await refundService.executeFullRefund(
        obligation.id as string,
        supportActor(),
        { providerOverride: provider as never },
      );

      assert.equal(second.ok, true);
      assert.equal(second.ok ? second.status : "", "REFUNDED");
      assert.equal(second.ok ? second.providerRefundId : "", "9001");
      assert.equal(postCalls, 1, "convergence comes from provider evidence, not a second POST");
      assert.equal(obligation.status, "REFUNDED");
    });
  });

  // -------------------------------------------------------------------------
  // Accounting + idempotency
  // -------------------------------------------------------------------------

  describe("accounting and idempotency", () => {
    it("writes exactly the three compensating REFUND lines with correct amounts/directions", async () => {
      const obligation = await runToRefunded();

      const refundLines = db.ledgerEntry.filter((l) => l.entryType === "REFUND");

      assert.equal(refundLines.length, 3);

      const escrow = refundLines.find((l) => l.account === "platform:escrow");
      const revenue = refundLines.find((l) => l.account === "platform:revenue");
      const payable = refundLines.find((l) => l.account === `advertiser:${ADV}:payable`);

      assert.ok(escrow && revenue && payable);

      assert.equal(escrow.direction, "DEBIT");
      assert.equal(escrow.amountMinor, 90000000n); // creatorAmountMinor
      assert.equal(revenue.direction, "DEBIT");
      assert.equal(revenue.amountMinor, 13500000n); // platformFeeMinor
      assert.equal(payable.direction, "CREDIT");
      assert.equal(payable.amountMinor, 103500000n); // advertiserTotalMinor

      for (const line of refundLines) {
        assert.equal(line.currency, "NGN");
        assert.ok(String(line.idempotencyKey).startsWith(`evt:${obligation.id as string}:refund_completed:`));
      }
    });

    it("writes refund_requested and refund_completed events with deterministic keys", async () => {
      const obligation = await runToRefunded();

      const requested = db.financialEvent.find((e) => e.eventType === "refund_requested");
      const completed = db.financialEvent.find((e) => e.eventType === "refund_completed");

      assert.ok(requested);
      assert.ok(completed);
      assert.equal(requested!.idempotencyKey, `evt:${obligation.id as string}:refund_requested`);
      assert.equal(completed!.idempotencyKey, `evt:${obligation.id as string}:refund_completed`);
    });

    it("completing twice is idempotent: no duplicate events or ledger rows", async () => {
      const obligation = await runToRefunded();

      const eventsBefore = db.financialEvent.length;
      const ledgerBefore = db.ledgerEntry.length;

      // Replay the completion through the same machinery — the deterministic
      // event key + conditional update make this a no-op.
      const replay = await refundService.executeFullRefund(
        obligation.id as string,
        supportActor(),
        { providerOverride: fakeProvider(async () => ({ status: "processed", providerReference: "424246" })) as never },
      );

      // REFUNDED is not a refund-requestable state: the service refuses —
      // which is itself the idempotent guard (nothing can double-refund).
      assert.equal(replay.ok, false);
      assert.equal(replay.ok ? "" : replay.code, "INVALID_STATE");
      assert.equal(db.financialEvent.length, eventsBefore);
      assert.equal(db.ledgerEntry.length, ledgerBefore);
      assert.equal(obligation.status, "REFUNDED");
    });

    it("a duplicate concurrent refund request converges: one event set, one ledger set", async () => {
      const obligation = addObligation();
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      const outcomes = await Promise.all([
        refundService.executeFullRefund(
          obligation.id as string,
          supportActor(),
          { providerOverride: fakeProvider(async () => ({ status: "processed", providerReference: "777" })) as never },
        ),
        refundService.executeFullRefund(
          obligation.id as string,
          supportActor(),
          { providerOverride: fakeProvider(async () => ({ status: "processed", providerReference: "778" })) as never },
        ),
      ]);


      // The state machine lets exactly one conditional update win; the loser
      // replays idempotently (same target state) or is refused — either way
      // the accounting invariants below hold.
      const succeeded = outcomes.filter((r) => r.ok);

      assert.ok(succeeded.length >= 1);

      const requestedEvents = db.financialEvent.filter((e) => e.eventType === "refund_requested");
      const completedEvents = db.financialEvent.filter((e) => e.eventType === "refund_completed");
      const refundLines = db.ledgerEntry.filter((l) => l.entryType === "REFUND");

      // Exactly ONE logical refund in the journal, whatever the interleaving.
      assert.equal(requestedEvents.length, 1);
      assert.equal(completedEvents.length, 1);
      assert.equal(refundLines.length, 3);
      assert.equal(obligation.status, "REFUNDED");
    });

    it("uses a deterministic refund reference (attempt-row uniqueness)", async () => {
      const obligation = addObligation();

      assert.equal(refundService.refundReferenceFor(obligation.id as string), `ref-${obligation.id as string}`);
    });

    it("records the refund attempt row before the provider call (recoverable evidence)", async () => {
      const obligation = addObligation();
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      await refundService.executeFullRefund(
        obligation.id as string,
        supportActor(),
        { providerOverride: fakeProvider(async () => ({ status: "processed", providerReference: "424247" })) as never },
      );

      const attempt = db.paymentProviderTransaction.find(
        (t) => t.providerReference === `ref-${obligation.id as string}`,
      );

      assert.ok(attempt);
      assert.equal(attempt!.providerStatus, "SUCCEEDED");
      assert.equal(attempt!.amountMinor, obligation.advertiserTotalMinor);
    });
  });

  // -------------------------------------------------------------------------
  // Regression
  // -------------------------------------------------------------------------

  describe("regression guards", () => {
    it("the refund flow never creates CreatorPayout rows", async () => {
      const obligation = addObligation();
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      await refundService.executeFullRefund(
        obligation.id as string,
        supportActor(),
        { providerOverride: fakeProvider(async () => ({ status: "processed", providerReference: "424248" })) as never },
      );

      assert.equal(db.creatorPayout.length, 0);

      // The only attempt row is the refund attempt itself (milestoneId null).
      const attemptRows = db.paymentProviderTransaction;

      assert.equal(attemptRows.length, 1);
      assert.equal(attemptRows[0]!.milestoneId ?? null, null);
    });

    it("ledger corrections use REFUND lines only — no FEE_REFUND entries in 14E", async () => {
      await runToRefunded();

      assert.equal(db.ledgerEntry.filter((l) => l.entryType === "FEE_REFUND").length, 0);
    });
  });
});
