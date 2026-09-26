import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Stage 14C closeout — bank-details UI wiring tests (action layer).
 *
 * Pins the UI-mount security matrix WITHOUT touching the payment
 * architecture: the action is exercised end-to-end through mocked framework
 * seams (next/cache, authz) and the established in-memory Prisma + fake
 * provider pattern, asserting that:
 *   - unauthenticated access is rejected before any service code runs;
 *   - advertiser access is rejected (requireRole("CREATOR") throws/redirects);
 *   - a creator can submit bank details successfully;
 *   - creator identity comes ONLY from the session (a forged creatorId in the
 *     form is ignored — the recipient is scoped to the session's profile);
 *   - the raw account number is never persisted anywhere;
 *   - recipient creation is idempotent through the action;
 *   - the display summary exposes only safe fields (no recipient code, no
 *     account number).
 */

// ---------------------------------------------------------------------------
// In-memory Prisma stub (recipient table is all the UI path touches)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { id: string };

const db: Record<string, Row[]> = {
  creatorPayoutRecipient: [],
};

let nextId = 1;
const id = (prefix: string) => `${prefix}-${nextId++}`;

function resetDb(): void {
  db.creatorPayoutRecipient = [];
  nextId = 1;
}

function uniqueError(): Error {
  const error = new Error("Unique constraint failed") as Error & { code: string };

  error.code = "P2002";

  return error;
}

const prismaStub = {
  creatorPayoutRecipient: {
    findUnique: async (args: {
      where: { creatorId_provider_currency_status?: Record<string, string> };
    }) => {
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
      const row = db.creatorPayoutRecipient.find(
        (r) =>
          r.creatorId === args.where.creatorId &&
          r.currency === args.where.currency &&
          r.status === args.where.status,
      );

      return row ? structuredClone(row) : null;
    },
    create: async (args: { data: Record<string, unknown> }) => {
      const row = {
        status: "ACTIVE",
        createdAt: new Date(),
        ...args.data,
        id: typeof args.data.id === "string" ? args.data.id : id("recip"),
      } as Row;

      const duplicate = db.creatorPayoutRecipient.some(
        (r) =>
          r.creatorId === row.creatorId &&
          r.provider === row.provider &&
          r.currency === row.currency &&
          r.status === row.status,
      );

      if (duplicate) {
        throw uniqueError();
      }

      db.creatorPayoutRecipient.push(row);

      return structuredClone(row);
    },
  },
} as unknown as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Module mocks (registered BEFORE the modules under test are imported)
// ---------------------------------------------------------------------------

function mockModule(specifier: string, exports: Record<string, unknown>): void {
  (mock.module as (spec: string, opts: Record<string, unknown>) => void)(
    specifier,
    { exports },
  );
}

mockModule("server-only", {});
mockModule("@/lib/prisma", { prisma: prismaStub as never });
mockModule("next/cache", {
  revalidatePath: () => undefined,
});

// --- session seam ---------------------------------------------------------

type Role = "CREATOR" | "ADVERTISER" | null;

let sessionRole: Role = null;
let sessionProfileId: string | null = null;

/** `requireRole` mirrors the real seam: not the right role → never returns. */
function throwForRole(role: Role): never {
  throw new Error(
    role === null
      ? "UNAUTHENTICATED: redirected to login before any code ran"
      : "FORBIDDEN: non-creator redirected to /dashboard before any code ran",
  );
}

mockModule("@/lib/authz", {
  requireRole: (role: "CREATOR" | "ADVERTISER") => {
    if (sessionRole !== role) {
      throwForRole(sessionRole);
    }

    return Promise.resolve({ id: "session-user-1", role });
  },
});

// --- creator profile resolution (session user → profile id) ---------------

mockModule("@/services/creator.service", {
  getViewerCreator: async () => {
    // Mirrors the real seam: getViewerCreator → requireRole("CREATOR"), which
    // redirects (here: throws) before any service code runs for anonymous or
    // non-creator sessions.
    if (sessionRole === null) {
      throw new Error("UNAUTHENTICATED: redirected to login before any code ran");
    }

    if (sessionRole !== "CREATOR" || !sessionProfileId) {
      throw new Error("FORBIDDEN: non-creator redirected to /dashboard before any code ran");
    }

    return {
      userId: "session-user-1",
      profile: { id: sessionProfileId, userId: "session-user-1" },
    };
  },
});

// --- provider port (fake Paystack) ----------------------------------------

let createRecipientCalls = 0;

function configureFakeProvider(
  overrides: Partial<{ createRecipient: (request: Record<string, unknown>) => Promise<Record<string, unknown>> }> = {},
): void {
  createRecipientCalls = 0;

  paymentsPort.resetPaymentProviderForTests();
  paymentsPort.configurePaymentProvider({
    name: "paystack",
    createCharge: async () => ({ status: "failed", providerReference: null, reason: "unused" }),
    verifyTransaction: async () => ({ status: "unverified", providerReference: null, reason: "unused" }),
    verifyWebhook: async () => ({ verified: false, reason: "unused" }),
    createRefund: async () => ({ status: "failed", providerReference: null, reason: "unused" }),
    createPayout: async () => ({ status: "failed", providerReference: null, reason: "unused" }),
    getTransferStatus: async () => ({ status: "unknown", reason: "unused" }),
    createRecipient:
      overrides.createRecipient ??
      (async (request: Record<string, unknown>) => {
        createRecipientCalls += 1;

        const bankAccount = request.bankAccount as {
          accountNumber: string;
          bankCode: string;
          accountName: string;
        };

        // Mirror the adapter's contract: resolve + refuse a name mismatch.
        if (bankAccount.accountName !== "Test Creator") {
          return { status: "failed", reason: "The account name does not match the bank account — payouts must go to the creator's own account." };
        }

        return { status: "created", recipientCode: `RCP_${bankAccount.accountNumber.slice(-4)}` };
      }),
  } as never);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

type PayoutsActions = typeof import("@/app/dashboard/_actions/payouts");
type PaymentsPort = typeof import("@/services/payments/index");

let actions: PayoutsActions;
let paymentsPort: PaymentsPort;

const SESSION_PROFILE = "profile-session-1";

function asCreator(): void {
  sessionRole = "CREATOR";
  sessionProfileId = SESSION_PROFILE;
}

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();

  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }

  return data;
}

describe("Stage 14C closeout — bank details UI wiring", () => {
  before(async () => {
    actions = await import("@/app/dashboard/_actions/payouts");
    paymentsPort = await import("@/services/payments/index");
  });

  beforeEach(() => {
    resetDb();
    sessionRole = null;
    sessionProfileId = null;
    paymentsPort.resetPaymentProviderForTests();
  });

  it("rejects unauthenticated access before any service code runs", async () => {
    sessionRole = null;

    await assert.rejects(
      actions.savePayoutRecipientAction(null, formData({
        accountNumber: "0123456789",
        bankCode: "058",
        accountName: "Test Creator",
      })),
      /UNAUTHENTICATED/,
    );

    assert.equal(db.creatorPayoutRecipient.length, 0);
    assert.equal(paymentsPort.hasPaymentProvider(), false);
  });

  it("rejects advertiser access", async () => {
    sessionRole = "ADVERTISER";

    await assert.rejects(
      actions.savePayoutRecipientAction(null, formData({
        accountNumber: "0123456789",
        bankCode: "058",
        accountName: "Test Creator",
      })),
      /FORBIDDEN/,
    );

    assert.equal(db.creatorPayoutRecipient.length, 0);
  });

  it("a creator can submit bank details and gets SAFE confirmation only", async () => {
    asCreator();
    configureFakeProvider();

    const result = await actions.savePayoutRecipientAction(null, formData({
      accountNumber: "0123456789",
      bankCode: "058",
      accountName: "Test Creator",
    }));

    assert.equal(result.success, true);

    if (result.success) {
      assert.equal(result.data.accountName, "Test Creator");
      assert.equal(result.data.bankName, "GTBank");
      assert.equal(result.data.status, "ACTIVE");
      // Safe-confirmation guarantees: no account number, no recipient code.
      assert.equal(JSON.stringify(result.data).includes("0123456789"), false);
      assert.equal(JSON.stringify(result.data).includes("RCP_"), false);
    }

    // Exactly one recipient, scoped to the session profile.
    assert.equal(db.creatorPayoutRecipient.length, 1);
    assert.equal(db.creatorPayoutRecipient[0].creatorId, SESSION_PROFILE);
  });

  it("a creator cannot impersonate another creator — client creatorId is ignored", async () => {
    asCreator();
    configureFakeProvider();

    // An attacker stuffs creatorId / recipientCode into the form — the action
    // never reads either; identity comes from the session.
    const result = await actions.savePayoutRecipientAction(null, formData({
      accountNumber: "0123456789",
      bankCode: "058",
      accountName: "Test Creator",
      creatorId: "profile-victim-9",
      recipientCode: "RCP_attacker",
    }));

    assert.equal(result.success, true);
    assert.equal(db.creatorPayoutRecipient.length, 1);
    assert.equal(db.creatorPayoutRecipient[0].creatorId, SESSION_PROFILE);
    assert.equal(db.creatorPayoutRecipient[0].recipientCode, "RCP_6789");
    assert.notEqual(db.creatorPayoutRecipient[0].recipientCode, "RCP_attacker");
    assert.notEqual(db.creatorPayoutRecipient[0].creatorId, "profile-victim-9");
  });

  it("the raw account number is NOT persisted (and the client code is never stored)", async () => {
    asCreator();
    configureFakeProvider();

    await actions.savePayoutRecipientAction(null, formData({
      accountNumber: "0123456789",
      bankCode: "058",
      accountName: "Test Creator",
      recipientCode: "RCP_client_supplied",
    }));

    const stored = JSON.stringify(db.creatorPayoutRecipient);

    assert.equal(stored.includes("0123456789"), false);
    assert.equal(stored.includes("RCP_client_supplied"), false);
    // The server-created code IS stored (server-managed destination).
    assert.equal(db.creatorPayoutRecipient[0].recipientCode, "RCP_6789");
  });

  it("recipient creation is idempotent through the action", async () => {
    asCreator();
    configureFakeProvider();

    const first = await actions.savePayoutRecipientAction(null, formData({
      accountNumber: "0123456789",
      bankCode: "058",
      accountName: "Test Creator",
    }));

    assert.equal(first.success, true);

    const callsAfterFirst = createRecipientCalls;

    const second = await actions.savePayoutRecipientAction(null, formData({
      accountNumber: "0123456789",
      bankCode: "058",
      accountName: "Test Creator",
    }));

    assert.equal(second.success, true);

    if (second.success) {
      assert.equal(second.data.idempotentReplay, true);
    }

    // No second provider call, no second row.
    assert.equal(createRecipientCalls, callsAfterFirst);
    assert.equal(db.creatorPayoutRecipient.length, 1);
  });

  it("an existing recipient is displayed with safe fields only", async () => {
    asCreator();
    configureFakeProvider();

    await actions.savePayoutRecipientAction(null, formData({
      accountNumber: "0123456789",
      bankCode: "058",
      accountName: "Test Creator",
    }));

    const summary = await actions.getMyPayoutRecipientAction();

    assert.equal(summary.success, true);

    if (summary.success) {
      assert.equal(summary.data.accountName, "Test Creator");
      assert.equal(summary.data.status, "ACTIVE");
      assert.equal(typeof summary.data.connectedAt, "string");
      // No recipient code, no account number in the display payload.
      const serialized = JSON.stringify(summary.data);

      assert.equal(serialized.includes("RCP_"), false);
      assert.equal(serialized.includes("0123456789"), false);
    }
  });

  it("the update flow is safe: re-saving goes through the same flow and never duplicates", async () => {
    asCreator();
    configureFakeProvider();

    // First destination.
    const first = await actions.savePayoutRecipientAction(null, formData({
      accountNumber: "0123456789",
      bankCode: "058",
      accountName: "Test Creator",
    }));

    assert.equal(first.success, true);

    const callsAfterFirst = createRecipientCalls;

    // Submitting again (any details) while a destination is ACTIVE is a
    // SAFE no-op replay: no provider call, no second row, data unchanged.
    const second = await actions.savePayoutRecipientAction(null, formData({
      accountNumber: "0123456789",
      bankCode: "058",
      accountName: "Test Creator",
    }));

    assert.equal(second.success, true);

    if (second.success) {
      assert.equal(second.data.idempotentReplay, true);
    }

    assert.equal(createRecipientCalls, callsAfterFirst);
    assert.equal(db.creatorPayoutRecipient.length, 1);
    assert.equal(db.creatorPayoutRecipient[0].accountName, "Test Creator");
  });

  it("account-name verification stays enforced through the action", async () => {
    asCreator();
    configureFakeProvider();

    // No recipient yet: the provider's name check decides.
    const rejected = await actions.savePayoutRecipientAction(null, formData({
      accountNumber: "0123456789",
      bankCode: "058",
      accountName: "Someone Else",
    }));

    assert.equal(rejected.success, false);

    if (!rejected.success) {
      assert.match(rejected.error, /does not match/);
    }

    assert.equal(db.creatorPayoutRecipient.length, 0);
    // The provider WAS contacted (it resolves the account name) but refused
    // to create anything — nothing was stored.
    assert.ok(createRecipientCalls >= 1);
  });

  it("validation failures are reported without touching storage or provider", async () => {
    asCreator();
    configureFakeProvider();

    const result = await actions.savePayoutRecipientAction(null, formData({
      accountNumber: "12345", // invalid NUBAN length
      bankCode: "058",
      accountName: "Test Creator",
    }));

    assert.equal(result.success, false);

    if (!result.success) {
      assert.match(result.error, /10-digit/);
    }

    assert.equal(db.creatorPayoutRecipient.length, 0);
    assert.equal(createRecipientCalls, 0);
  });
});
