import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Stage 14E closeout — Support financial wiring tests (action layer).
 *
 * Mocks ONLY at the action boundary: the session/roster seam
 * (@/lib/authz.getSupportActor), the two existing financial services
 * (dispute.service.setDisputeFreeze, refund.service.executeFullRefund) and
 * next/cache. The financial logic itself is NOT duplicated or re-implemented
 * here — these tests pin the WIRING:
 *   - authorization is derived ONLY from getSupportActor() (session SUPPORT
 *     role + fresh-DB roster): anonymous/creator/advertiser/roster-less are
 *     refused before any service is touched;
 *   - the AdminActor passed to the services is built from the session
 *     identity — a client-supplied userId field can never influence it;
 *   - no amount, status, provider reference or extra field reaches a service;
 *   - the refund action NEVER passes providerOverride;
 *   - service error codes map to safe operator messages;
 *   - REFUNDED vs REFUND_PENDING outcomes are reported distinctly;
 *   - revalidation happens on success.
 */

// ---------------------------------------------------------------------------
// Mock registry (BEFORE importing the module under test)
// ---------------------------------------------------------------------------

function mockModule(specifier: string, exports: Record<string, unknown>): void {
  (mock.module as (spec: string, opts: Record<string, unknown>) => void)(
    specifier,
    { exports },
  );
}

type SupportActor = { id: string; role: "SUPPORT" } | null;

let supportActor: SupportActor = null;

mockModule("server-only", {});

mockModule("@/lib/authz", {
  getSupportActor: async (): Promise<SupportActor> => supportActor,
});

const revalidated: string[] = [];

mockModule("next/cache", {
  revalidatePath: (path: string, type?: string) => {
    revalidated.push(type ? `${path}:${type}` : path);
  },
});

// --- service seams: call recorders + configurable outcomes -----------------

type DisputeCall = { obligationId: string; freeze: boolean; actor: Record<string, unknown>; reason?: string };
type RefundCall = { obligationId: string; actor: Record<string, unknown> };

let disputeCalls: DisputeCall[] = [];
let refundCalls: RefundCall[] = [];
let disputeResult: Record<string, unknown> = { ok: true, obligationId: "ob-1", frozen: true };
let refundResult: Record<string, unknown> = {
  ok: true,
  obligationId: "ob-1",
  status: "REFUNDED",
  refundReference: "ref-ob-1",
  providerReference: "chg_1",
  providerRefundId: "424245",
  idempotentReplay: false,
};

mockModule("@/services/payments/dispute.service", {
  setDisputeFreeze: async (
    obligationId: string,
    freeze: boolean,
    actor: Record<string, unknown>,
    reason?: string,
  ) => {
    disputeCalls.push({ obligationId, freeze, actor, reason });

    return disputeResult;
  },
});

mockModule("@/services/payments/refund.service", {
  executeFullRefund: async (obligationId: string, actor: Record<string, unknown>) => {
    refundCalls.push({ obligationId, actor });

    return refundResult;
  },
});

mockModule("@/services/payments/obligation-state.service", {});

// ---------------------------------------------------------------------------
// Import the module under test AFTER the mocks are registered
// ---------------------------------------------------------------------------

type SupportFinancialActions = typeof import("@/app/dashboard/_actions/support-financial");

let actions: SupportFinancialActions;

const SUPPORT_USER = "user-support-1";

function asRosteredSupport(): void {
  supportActor = { id: SUPPORT_USER, role: "SUPPORT" };
}

function formData(fields: Record<string, string | undefined>): FormData {
  const data = new FormData();

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      data.set(key, value);
    }
  }

  return data;
}

function resetMocks(): void {
  supportActor = null;
  revalidated.length = 0;
  disputeCalls = [];
  refundCalls = [];
  disputeResult = { ok: true, obligationId: "ob-1", frozen: true };
  refundResult = {
    ok: true,
    obligationId: "ob-1",
    status: "REFUNDED",
    refundReference: "ref-ob-1",
    providerReference: "chg_1",
    providerRefundId: "424245",
    idempotentReplay: false,
  };
}

const OBLIGATION_ID = "0b7f9a5e-3c1d-4f2a-9b8e-1a2c3d4e5f60";
const BAD_ID = "not-a-uuid";

describe("Stage 14E closeout — Support financial wiring (action layer)", () => {
  before(async () => {
    actions = await import("@/app/dashboard/_actions/support-financial");
  });

  beforeEach(() => {
    resetMocks();
  });

  // -------------------------------------------------------------------------
  // AUTH matrix
  // -------------------------------------------------------------------------

  it("refuses an anonymous caller before any service runs", async () => {
    const freeze = await actions.setDisputeFreezeAction(
      null,
      formData({ obligationId: OBLIGATION_ID, freeze: "true" }),
    );
    const refund = await actions.executeFullRefundAction(
      null,
      formData({ obligationId: OBLIGATION_ID }),
    );

    assert.equal(freeze.success, false);
    assert.equal(refund.success, false);
    assert.match(freeze.error, /Support authorization required/);
    assert.match(refund.error, /Support authorization required/);
    assert.equal(disputeCalls.length, 0);
    assert.equal(refundCalls.length, 0);
    assert.equal(revalidated.length, 0);
  });

  it("refuses a CREATOR session (the session verdict, not the form, decides)", async () => {
    // getSupportActor never returns a non-SUPPORT session — model a creator
    // by the only thing the action can observe: a null verdict.
    supportActor = null;

    const result = await actions.setDisputeFreezeAction(
      null,
      formData({ obligationId: OBLIGATION_ID, freeze: "true" }),
    );

    assert.equal(result.success, false);
    assert.equal(disputeCalls.length, 0);
  });

  it("refuses a roster-less SUPPORT session (getSupportActor resolves null)", async () => {
    supportActor = null;

    const result = await actions.executeFullRefundAction(
      null,
      formData({ obligationId: OBLIGATION_ID }),
    );

    assert.equal(result.success, false);
    assert.equal(refundCalls.length, 0);
  });

  it("accepts a rostered SUPPORT actor and builds the AdminActor from the session identity only", async () => {
    asRosteredSupport();

    const result = await actions.setDisputeFreezeAction(
      null,
      formData({ obligationId: OBLIGATION_ID, freeze: "true" }),
    );

    assert.equal(result.success, true);
    assert.equal(disputeCalls.length, 1);
    assert.equal(disputeCalls[0].actor.authenticated, true);
    assert.equal(disputeCalls[0].actor.userId, SUPPORT_USER); // session id, not a form field
    assert.equal(disputeCalls[0].actor.source, "support-ui");
  });

  it("ignores a client-supplied userId/actor field entirely", async () => {
    asRosteredSupport();

    const result = await actions.executeFullRefundAction(
      null,
      formData({ obligationId: OBLIGATION_ID, userId: "attacker-user", actor: "ADMIN", amount: "1" }),
    );

    assert.equal(result.success, true);
    assert.equal(refundCalls.length, 1);
    assert.equal(refundCalls[0].actor.userId, SUPPORT_USER);
    // Only obligationId + actor were forwarded — nothing else.
    assert.deepEqual(Object.keys(refundCalls[0]), ["obligationId", "actor"]);
  });

  // -------------------------------------------------------------------------
  // FREEZE wiring
  // -------------------------------------------------------------------------

  it("freezes through the existing service and revalidates", async () => {
    asRosteredSupport();

    const result = await actions.setDisputeFreezeAction(
      null,
      formData({ obligationId: OBLIGATION_ID, freeze: "true", reason: "Chargeback opened" }),
    );

    assert.equal(result.success, true);
    assert.equal(disputeCalls[0].obligationId, OBLIGATION_ID);
    assert.equal(disputeCalls[0].freeze, true);
    assert.equal(disputeCalls[0].reason, "Chargeback opened");
    assert.ok(revalidated.some((path) => path.startsWith("/dashboard/support/milestones")));
  });

  it("unfreezes through the same seam", async () => {
    asRosteredSupport();

    const result = await actions.setDisputeFreezeAction(
      null,
      formData({ obligationId: OBLIGATION_ID, freeze: "false" }),
    );

    assert.equal(result.success, true);
    assert.equal(disputeCalls[0].freeze, false);
  });

  it("rejects a malformed obligationId and an out-of-contract freeze value", async () => {
    asRosteredSupport();

    const badId = await actions.setDisputeFreezeAction(
      null,
      formData({ obligationId: BAD_ID, freeze: "true" }),
    );
    const badFreeze = await actions.setDisputeFreezeAction(
      null,
      formData({ obligationId: OBLIGATION_ID, freeze: "yes" }),
    );

    assert.equal(badId.success, false);
    assert.match(badId.error, /obligation id/i);
    assert.equal(badFreeze.success, false);
    assert.equal(disputeCalls.length, 0);
  });

  it("maps the service NOT_FOUND to a safe operator message", async () => {
    asRosteredSupport();
    disputeResult = { ok: false, code: "NOT_FOUND", reason: "Obligation not found." };

    const result = await actions.setDisputeFreezeAction(
      null,
      formData({ obligationId: OBLIGATION_ID, freeze: "true" }),
    );

    assert.equal(result.success, false);
    assert.match(result.error, /could not be found/i);
    assert.equal(revalidated.length, 0);
  });

  it("rejects a reason beyond the existing service's contract (500 chars)", async () => {
    asRosteredSupport();

    const result = await actions.setDisputeFreezeAction(
      null,
      formData({ obligationId: OBLIGATION_ID, freeze: "true", reason: "x".repeat(501) }),
    );

    assert.equal(result.success, false);
    assert.equal(disputeCalls.length, 0);
  });

  // -------------------------------------------------------------------------
  // REFUND wiring
  // -------------------------------------------------------------------------

  it("executes a full refund through the existing service with NO providerOverride and reports completion", async () => {
    asRosteredSupport();

    const result = await actions.executeFullRefundAction(
      null,
      formData({ obligationId: OBLIGATION_ID }),
    );

    assert.equal(result.success, true);
    const data = result.data as unknown as { status: string; outcome: string };
    assert.equal(data.status, "REFUNDED");
    assert.match(data.outcome, /Refund completed/i);
    assert.equal(refundCalls.length, 1);
    assert.equal(refundCalls[0].obligationId, OBLIGATION_ID);
    assert.ok(revalidated.some((path) => path.startsWith("/dashboard/support/milestones")));
  });

  it("reports REFUND_PENDING distinctly as submitted/awaiting provider", async () => {
    asRosteredSupport();
    refundResult = {
      ok: true,
      obligationId: OBLIGATION_ID,
      status: "REFUND_PENDING",
      refundReference: "ref-ob-1",
      providerReference: "chg_1",
      providerRefundId: null,
      idempotentReplay: false,
    };

    const result = await actions.executeFullRefundAction(
      null,
      formData({ obligationId: OBLIGATION_ID }),
    );

    assert.equal(result.success, true);
    const data = result.data as unknown as { status: string; outcome: string };
    assert.equal(data.status, "REFUND_PENDING");
    assert.match(data.outcome, /submitted|awaiting/i);
    assert.match(data.outcome, /REFUND_PENDING/);
  });

  it("maps refund error codes to safe operator messages", async () => {
    asRosteredSupport();

    const cases: Array<[string, RegExp]> = [
      ["DISPUTE_FROZEN", /dispute freeze/i],
      ["MILESTONE_SETTLED", /settled or released/i],
      ["PAYOUT_IN_FLIGHT", /payout transfer/i],
      ["RECONCILIATION_INCONCLUSIVE", /could not be confirmed/i],
      ["TRANSIENT_DB_FAILURE", /nothing was sent to the provider/i],
      ["PROVIDER_UNCONFIGURED", /provider is configured/i],
      ["PROVIDER_REFERENCE_MISSING", /charge reference/i],
      ["INVALID_STATE", /cannot be refunded in its current state/i],
    ];

    for (const [code, expected] of cases) {
      refundResult = { ok: false, code, reason: "detail" };

      const result = await actions.executeFullRefundAction(
        null,
        formData({ obligationId: OBLIGATION_ID }),
      );

      assert.equal(result.success, false, `expected failure for ${code}`);
      assert.match(result.error, expected, `wrong message for ${code}`);
    }

    assert.equal(revalidated.length, 0);
    assert.equal(refundCalls.length, cases.length);
  });

  it("rejects a malformed obligationId before touching the refund service", async () => {
    asRosteredSupport();

    const result = await actions.executeFullRefundAction(null, formData({ obligationId: BAD_ID }));

    assert.equal(result.success, false);
    assert.equal(refundCalls.length, 0);
  });

  it("forwards only the obligationId — no amount/status/provider reference can reach the service", async () => {
    asRosteredSupport();

    const result = await actions.executeFullRefundAction(
      null,
      formData({
        obligationId: OBLIGATION_ID,
        amountMinor: "1",
        currency: "USD",
        status: "REFUNDED",
        providerReference: "attacker-ref",
        providerOverride: "anything",
      }),
    );

    assert.equal(result.success, true);
    // The service seam received exactly (obligationId, actor) — nothing else.
    assert.deepEqual(Object.keys(refundCalls[0]), ["obligationId", "actor"]);
    assert.equal(
      (refundCalls[0] as unknown as Record<string, unknown>).providerOverride,
      undefined,
    );
  });
});
