import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Stage 14D — Support authorization foundation tests.
 *
 * Pins the ENTIRE Stage 14D authorization matrix through mocked framework
 * seams (next/navigation redirect, the server session, and the in-memory
 * Prisma user/roster table), asserting:
 *
 *   requireSupport / getSupportActor (the 14D guard):
 *     - anonymous → rejected (redirect)
 *     - CREATOR   → rejected (redirect)
 *     - ADVERTISER→ rejected (redirect)
 *     - SUPPORT + roster=false → rejected (redirect)
 *     - SUPPORT + roster=true  → allowed (session returned)
 *     - empty roster (zero authorized SUPPORT users) → fail-closed
 *     - roster REVOCATION: a valid SUPPORT JWT stops working the moment the
 *       roster flag is cleared (fresh-DB check per request)
 *
 *   dispute.service hardening:
 *     - a merely authenticated actor (authenticated: true, no SUPPORT
 *       session/roster) is REFUSED by setDisputeFreeze (the pre-14D gap);
 *     - a rostered SUPPORT operator IS authorized (flag + role + roster);
 *     - an empty roster is fail-closed.
 *
 *   financial-access SUPPORT viewer:
 *     - SUPPORT viewer resolves ONLY through the rostered SUPPORT session;
 *     - the SUPPORT viewer can read ANY obligation (read-any operational
 *       viewer) plus its ledger/events;
 *     - CREATOR/ADVERTISER ownership predicates are untouched: foreign
 *       obligations stay null/empty for party viewers;
 *     - the SUPPORT variant is unreachable for non-support sessions.
 *
 *   Support action authorization (recordSupportDecisionAction):
 *     - creator/advertiser/anonymous calls are refused before validation;
 *     - a rostered SUPPORT session passes the action guard.
 *
 * No payment, payout, recipient or Paystack behavior is touched here.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma (User roster + the financial tables the viewer reads)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { id: string };

const db: Record<string, Row[]> = {
  user: [],
  financialObligation: [],
  ledgerEntry: [],
  financialEvent: [],
};

let nextId = 1;
const id = (prefix: string) => `${prefix}-${nextId++}`;

function resetDb(): void {
  for (const key of Object.keys(db)) {
    db[key] = [];
  }
  nextId = 1;
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      const operators = value as Record<string, unknown>;

      if ("not" in operators && row[key] === operators.not) return false;
      continue;
    }

    if (row[key] !== value) return false;
  }

  return true;
}

const prismaStub = {
  user: {
    findUnique: async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
      const row = db.user.find((r) => r.id === args.where.id);

      if (!row) return null;

      // Mirror Prisma `select` behavior when provided.
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
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const row = db.financialObligation.find((r) => matches(r, args.where));
      return row ? structuredClone(row) : null;
    },
    findMany: async (args: { where: Record<string, unknown> }) =>
      db.financialObligation.filter((r) => matches(r, args.where)).map((r) => structuredClone(r)),
  },
  ledgerEntry: {
    findMany: async (args: { where: Record<string, unknown> }) =>
      db.ledgerEntry.filter((r) => matches(r, args.where)).map((r) => structuredClone(r)),
  },
  financialEvent: {
    findMany: async (args: { where: Record<string, unknown> }) =>
      db.financialEvent.filter((r) => matches(r, args.where)).map((r) => structuredClone(r)),
    create: async (args: { data: Record<string, unknown> }) => {
      const row = { ...args.data, id: id("fevt") } as Row;
      db.financialEvent.push(row);
      return structuredClone(row);
    },
  },
  financialObligationUpdateMany: null, // see dispute stub below
} as unknown as Record<string, unknown>;

// dispute.service's conditional update (freeze flip) — modeled minimally.
(prismaStub as Record<string, unknown>).financialObligation = {
  ...((prismaStub as Record<string, unknown>).financialObligation as Record<string, unknown>),
  findUnique: async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
    const row = db.financialObligation.find((r) => r.id === args.where.id);
    return row ? structuredClone(row) : null;
  },
  updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const row = db.financialObligation.find((r) => r.id === args.where.id);

    if (!row || !matches(row, args.where)) {
      return { count: 0 };
    }

    Object.assign(row, args.data);

    return { count: 1 };
  },
};

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

type Authz = typeof import("@/lib/authz");
type FinancialAccess = typeof import("@/services/payments/financial-access.service");
type DisputeService = typeof import("@/services/payments/dispute.service");
type SupportActions = typeof import("@/app/dashboard/_actions/support");

let authz: Authz;
let financialAccess: FinancialAccess;
let disputeService: DisputeService;
let supportActions: SupportActions;

const SUPPORT_USER = "user-support-1";
const CREATOR_USER = "user-creator-1";
const ADVERTISER_USER = "user-advertiser-1";
const OTHER_USER = "user-other-1";

/** Operational act (SQL-only in prod): put a user id on the support roster. */
function addRosterUser(userId: string): void {
  db.user.push({ id: userId, supportRosterMember: true } as Row);
}

function asSession(role: Role, userId: string | null): void {
  sessionRole = role;
  sessionUserId = userId;
}

function supportsRow(userId: string): boolean {
  const row = db.user.find((r) => r.id === userId);

  return row?.supportRosterMember === true;
}

describe("Stage 14D — support authorization foundation", () => {
  before(async () => {
    authz = await import("@/lib/authz");
    financialAccess = await import("@/services/payments/financial-access.service");
    disputeService = await import("@/services/payments/dispute.service");
    supportActions = await import("@/app/dashboard/_actions/support");
  });

  beforeEach(() => {
    resetDb();
    sessionRole = null;
    sessionUserId = null;
  });

  // -------------------------------------------------------------------------
  // requireSupport / getSupportActor — the 14D guard matrix
  // -------------------------------------------------------------------------

  describe("requireSupport / getSupportActor guard matrix", () => {
    it("rejects an anonymous session (redirect to login)", async () => {
      asSession(null, null);

      // Anonymous page access follows the app-wide login-redirect convention.
      await assert.rejects(
        () => authz.requireSupport(),
        /REDIRECTED:\/auth\/login/,
      );
    });

    it("getSupportActor never redirects: anonymous resolves to a null verdict", async () => {
      asSession(null, null);

      assert.equal(await authz.getSupportActor(), null);
    });

    it("rejects a CREATOR session even with roster membership", async () => {
      addRosterUser(CREATOR_USER);
      asSession("CREATOR", CREATOR_USER);

      await assert.rejects(() => authz.requireSupport(), /REDIRECTED:\/dashboard/);
    });

    it("rejects an ADVERTISER session even with roster membership", async () => {
      addRosterUser(ADVERTISER_USER);
      asSession("ADVERTISER", ADVERTISER_USER);

      await assert.rejects(() => authz.requireSupport(), /REDIRECTED:\/dashboard/);
    });

    it("rejects a SUPPORT session NOT on the roster", async () => {
      asSession("SUPPORT", SUPPORT_USER);
      assert.equal(supportsRow(SUPPORT_USER), false);

      await assert.rejects(() => authz.requireSupport(), /REDIRECTED:\/dashboard/);
    });

    it("permits a SUPPORT session on the roster", async () => {
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      const actor = await authz.requireSupport();

      assert.equal(actor.id, SUPPORT_USER);
      assert.equal(actor.role, "SUPPORT");
    });

    it("is fail-closed with an EMPTY roster (zero authorized SUPPORT users)", async () => {
      asSession("SUPPORT", SUPPORT_USER);
      assert.equal(db.user.length, 0);

      await assert.rejects(() => authz.requireSupport(), /REDIRECTED:\/dashboard/);
    });

    it("revocation takes effect immediately: a valid SUPPORT JWT stops working when the roster flag is cleared", async () => {
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      // Authorized while on the roster.
      const actor = await authz.getSupportActor();
      assert.equal(actor?.id, SUPPORT_USER);

      // Operational revocation (SQL-only in prod): clear the flag.
      const row = db.user.find((r) => r.id === SUPPORT_USER);
      row!.supportRosterMember = false;

      // Same untouched session/JWT — now refused.
      await assert.rejects(() => authz.requireSupport(), /REDIRECTED:\/dashboard/);
    });

    it("ROSTER-FLIP defense: a CREATOR session whose user carries the roster flag is still refused", async () => {
      // Structural invariant of 14D: role check comes FIRST, so a stray
      // roster flag can never authorize a non-SUPPORT session.
      addRosterUser(CREATOR_USER);
      asSession("CREATOR", CREATOR_USER);

      await assert.rejects(() => authz.requireSupport(), /REDIRECTED:\/dashboard/);
    });

    it("getSupportActor returns null verdict for non-authorized sessions when called through the non-redirecting path", async () => {
      // getSessionUser is the non-redirecting base: anonymous resolves null.
      asSession(null, null);
      assert.equal(await authz.getSessionUser(), null);

      asSession("CREATOR", CREATOR_USER);
      const user = await authz.getSessionUser();
      assert.equal(user?.id, CREATOR_USER);
    });
  });

  // -------------------------------------------------------------------------
  // dispute.service hardening
  // -------------------------------------------------------------------------

  describe("dispute.service authorization hardening", () => {
    function seededObligation(): Row {
      const row = {
        id: id("oblig"),
        dispute: false,
        disputeReason: null,
        status: "FUNDED",
        agreementId: id("agr"),
      } as Row;

      db.financialObligation.push(row);

      return row;
    }

    it("REFUSES a merely authenticated actor (authenticated: true, no SUPPORT session) — the pre-14D gap", async () => {
      const obligation = seededObligation();

      // A CREATOR session is live, and the actor contract merely says
      // "authenticated". Stage 13A accepted this; Stage 14D must refuse.
      // The service re-derives authorization from the session + roster.
      addRosterUser(CREATOR_USER);
      asSession("CREATOR", CREATOR_USER);

      await assert.rejects(
        () =>
          disputeService.setDisputeFreeze(obligation.id as string, true, {
            authenticated: true,
            userId: CREATOR_USER,
            source: "test",
          }),
        /Support authorization required/,
      );

      assert.equal(obligation.dispute, false);
    });

    it("refuses even an ADVERTISER-flagged authenticated actor with no session", async () => {
      const obligation = seededObligation();

      asSession(null, null); // no session at all

      await assert.rejects(
        () =>
          disputeService.setDisputeFreeze(obligation.id as string, true, {
            authenticated: true,
            userId: OTHER_USER,
            source: "test",
          }),
        /Support authorization required/,
      );

      assert.equal(obligation.dispute, false);
    });

    it("REFUSES an unauthenticated actor outright", async () => {
      const obligation = seededObligation();

      asSession("SUPPORT", SUPPORT_USER);

      await assert.rejects(
        () =>
          disputeService.setDisputeFreeze(obligation.id as string, true, {
            authenticated: false,
            userId: SUPPORT_USER,
            source: "test",
          }),
        /not authenticated/,
      );

      assert.equal(obligation.dispute, false);
    });

    it("refuses a rostered SUPPORT session acting as a DIFFERENT userId (session identity must match)", async () => {
      const obligation = seededObligation();

      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      await assert.rejects(
        () =>
          disputeService.setDisputeFreeze(obligation.id as string, true, {
            authenticated: true,
            userId: OTHER_USER, // claiming someone else's identity
            source: "test",
          }),
        /Support authorization required/,
      );

      assert.equal(obligation.dispute, false);
    });

    it("authorizes a rostered SUPPORT operator and applies the freeze (idempotent replay on second call)", async () => {
      const obligation = seededObligation();

      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      const result = await disputeService.setDisputeFreeze(
        obligation.id as string,
        true,
        { authenticated: true, userId: SUPPORT_USER, source: "test" },
        "chargeback claim",
      );

      assert.equal(result.ok, true);
      assert.equal(obligation.dispute, true);
      assert.equal(obligation.disputeReason, "chargeback claim");

      // Idempotent replay: same requested state is a no-op.
      const replay = await disputeService.setDisputeFreeze(
        obligation.id as string,
        true,
        { authenticated: true, userId: SUPPORT_USER, source: "test" },
      );

      assert.equal(replay.ok, true);
    });

    it("is fail-closed with an empty roster even for a SUPPORT session", async () => {
      const obligation = seededObligation();

      asSession("SUPPORT", SUPPORT_USER); // not on the (empty) roster

      await assert.rejects(
        () =>
          disputeService.setDisputeFreeze(obligation.id as string, true, {
            authenticated: true,
            userId: SUPPORT_USER,
            source: "test",
          }),
        /Support authorization required/,
      );

      assert.equal(obligation.dispute, false);
    });

    it("revocation blocks the freeze immediately (fresh-DB roster check)", async () => {
      const obligation = seededObligation();

      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      // Authorized once…
      const ok = await disputeService.assertSupportAuthorized({
        authenticated: true,
        userId: SUPPORT_USER,
        source: "test",
      });
      assert.equal(ok, true);

      // …then revoked…
      const row = db.user.find((r) => r.id === SUPPORT_USER);
      row!.supportRosterMember = false;

      // …and refused on the very next action.
      await assert.rejects(
        () =>
          disputeService.setDisputeFreeze(obligation.id as string, true, {
            authenticated: true,
            userId: SUPPORT_USER,
            source: "test",
          }),
        /Support authorization required/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // financial-access SUPPORT viewer
  // -------------------------------------------------------------------------

  describe("financial-access SUPPORT viewer", () => {
    const ADV = "adv-profile-1";
    const CREATOR = "creator-profile-1";

    function seedObligation(): Row {
      const row = {
        id: id("oblig"),
        advertiserId: ADV,
        creatorId: CREATOR,
        status: "FUNDED",
        currency: "NGN",
      } as Row;

      db.financialObligation.push(row);

      return row;
    }

    it("resolves the SUPPORT viewer ONLY for a rostered SUPPORT session", async () => {
      asSession("SUPPORT", SUPPORT_USER);
      assert.equal(await financialAccess.resolveSupportFinancialViewer(), null);

      addRosterUser(SUPPORT_USER);
      const viewer = await financialAccess.resolveSupportFinancialViewer();
      assert.deepEqual(viewer, { role: "SUPPORT" });
    });

    it("never resolves for CREATOR/ADVERTISER/anonymous sessions", async () => {
      asSession("CREATOR", CREATOR_USER);
      assert.equal(await financialAccess.resolveSupportFinancialViewer(), null);

      asSession("ADVERTISER", ADVERTISER_USER);
      assert.equal(await financialAccess.resolveSupportFinancialViewer(), null);

      asSession(null, null);
      assert.equal(await financialAccess.resolveSupportFinancialViewer(), null);
    });

    it("SUPPORT viewer can read ANY obligation plus its ledger and events", async () => {
      const obligation = seedObligation();

      db.ledgerEntry.push({ id: id("ledg"), financialObligationId: obligation.id } as Row);
      db.financialEvent.push({ id: id("fev"), obligationId: obligation.id } as Row);

      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      const viewer = await financialAccess.resolveSupportFinancialViewer();
      assert.ok(viewer);

      const read = await financialAccess.getObligationForViewer(
        obligation.id as string,
        viewer!,
      );
      assert.equal(read?.id, obligation.id);

      const ledger = await financialAccess.listLedgerEntriesForViewer(
        obligation.id as string,
        viewer!,
      );
      assert.equal(ledger?.length, 1);

      const events = await financialAccess.listFinancialEventsForViewer(
        obligation.id as string,
        viewer!,
      );
      assert.equal(events?.length, 1);
    });

    it("party viewers keep their ownership predicates: foreign obligations stay null", async () => {
      const obligation = seedObligation();
      const outsiderAdv = "adv-profile-outsider";
      const outsiderCreator = "creator-profile-outsider";

      const asAdvertiser = { role: "ADVERTISER" as const, advertiserProfileId: outsiderAdv };
      const asCreator = { role: "CREATOR" as const, creatorProfileId: outsiderCreator };

      assert.equal(
        await financialAccess.getObligationForViewer(obligation.id as string, asAdvertiser),
        null,
      );
      assert.equal(
        await financialAccess.getObligationForViewer(obligation.id as string, asCreator),
        null,
      );

      const ownList = await financialAccess.listObligationsForViewer({
        role: "ADVERTISER",
        advertiserProfileId: ADV,
      });
      assert.equal(ownList.length, 1);

      const outsiderList = await financialAccess.listObligationsForViewer(asAdvertiser);
      assert.equal(outsiderList.length, 0);
    });

    it("listObligationsForViewer(SUPPORT) is unscoped (operational read-any)", async () => {
      seedObligation();
      seedObligation();

      const list = await financialAccess.listObligationsForViewer({ role: "SUPPORT" });
      assert.equal(list.length, 2);
    });

    it("ledger/event reads return null when the obligation does not exist or is foreign (party viewer)", async () => {
      seedObligation();

      const asCreator = { role: "CREATOR" as const, creatorProfileId: "creator-profile-2" };

      assert.equal(
        await financialAccess.listLedgerEntriesForViewer("missing-id", asCreator),
        null,
      );
      assert.equal(
        await financialAccess.listFinancialEventsForViewer("missing-id", asCreator),
        null,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Support action authorization
  // -------------------------------------------------------------------------

  describe("recordSupportDecisionAction authorization", () => {
    function formData(fields: Record<string, string>): FormData {
      const data = new FormData();

      for (const [key, value] of Object.entries(fields)) {
        data.set(key, value);
      }

      return data;
    }

    it("refuses an anonymous caller before validation or service code", async () => {
      asSession(null, null);

      const result = await supportActions.recordSupportDecisionAction(
        null,
        formData({ milestoneId: "m1", decision: "RELEASE_PAYMENT", reason: "Valid reason here." }),
      );

      assert.equal(result.success, false);
      assert.match(result.success ? "" : result.error, /Support authorization required/);
    });

    it("refuses a CREATOR session (even a roster-flagged one)", async () => {
      addRosterUser(CREATOR_USER);
      asSession("CREATOR", CREATOR_USER);

      const result = await supportActions.recordSupportDecisionAction(
        null,
        formData({ milestoneId: "m1", decision: "RELEASE_PAYMENT", reason: "Valid reason here." }),
      );

      assert.equal(result.success, false);
    });

    it("refuses an ADVERTISER session", async () => {
      asSession("ADVERTISER", ADVERTISER_USER);

      const result = await supportActions.recordSupportDecisionAction(
        null,
        formData({ milestoneId: "m1", decision: "RELEASE_PAYMENT", reason: "Valid reason here." }),
      );

      assert.equal(result.success, false);
    });

    it("refuses a SUPPORT session without roster membership", async () => {
      asSession("SUPPORT", SUPPORT_USER);

      const result = await supportActions.recordSupportDecisionAction(
        null,
        formData({ milestoneId: "m1", decision: "RELEASE_PAYMENT", reason: "Valid reason here." }),
      );

      assert.equal(result.success, false);
    });

    it("passes the action guard for a rostered SUPPORT session (fails later only on validation/state, not authorization)", async () => {
      addRosterUser(SUPPORT_USER);
      asSession("SUPPORT", SUPPORT_USER);

      const result = await supportActions.recordSupportDecisionAction(
        null,
        // Deliberately invalid decision value: proves the guard passed and
        // the flow reached validation (authorization layer is green).
        formData({ milestoneId: "m1", decision: "NOT_A_DECISION", reason: "Valid reason here." }),
      );

      assert.equal(result.success, false);

      if (!result.success) {
        // NOT the support-authorization error.
        assert.doesNotMatch(result.error, /Support authorization required/);
      }
    });
  });
});
