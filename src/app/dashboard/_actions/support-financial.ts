"use server";

import { revalidatePath } from "next/cache";

import { getSupportActor } from "@/lib/authz";
import { setDisputeFreeze } from "@/services/payments/dispute.service";
import type { AdminActor } from "@/services/payments/dispute.service";
import { executeFullRefund } from "@/services/payments/refund.service";
import type { ActionResult } from "@/types";
import { disputeFreezeSchema, supportObligationActionSchema } from "@/validation/payments";

/**
 * Stage 14E closeout — Support wiring for the EXISTING dispute-freeze and
 * full-refund services (no financial logic lives here).
 *
 * AUTHORIZATION BOUNDARY (the Stage 14D seam, identical to
 * recordSupportDecisionAction / transitionManagedBriefAction):
 *   1. The actor id comes ONLY from the server session via getSupportActor():
 *      a SUPPORT session whose user is on the operator-maintained support
 *      roster (User.supportRosterMember — writable only by SQL/operations,
 *      re-read fresh from the database on every request). Fail-closed:
 *      anonymous callers, creators, advertisers and roster-less SUPPORT
 *      sessions are all refused before any validation or service code runs.
 *   2. The client identifies the obligation only. No amount, status,
 *      provider reference, actor id or userId is ever accepted from the
 *      client — every financial value is derived server-side by the
 *      services, and both services re-derive Support authorization
 *      independently (defense in depth, unchanged).
 *   3. Refunds are FULL refunds only: executeFullRefund charges the frozen
 *      advertiserTotalMinor and accepts no amount input by contract. The
 *      action passes NO providerOverride (test seam only — never from an
 *      action).
 */

/** The AdminActor contract, built strictly from the server session. */
function supportAdminActor(actorId: string): AdminActor {
  return {
    authenticated: true,
    userId: actorId,
    source: "support-ui",
  };
}

/**
 * Freeze or lift the dispute freeze on one obligation (the existing flag-only
 * overlay — the DISPUTED status is not used). Idempotent and audited by the
 * service; a concurrent flip replays as success.
 */
export async function setDisputeFreezeAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  // Fail closed before anything else — the verdict, not the form, decides.
  const actor = await getSupportActor();

  if (!actor) {
    return { success: false, error: "Support authorization required." };
  }

  const freezeRaw = formData.get("freeze");

  if (freezeRaw !== "true" && freezeRaw !== "false") {
    return { success: false, error: "A valid freeze action is required." };
  }

  const parsed = disputeFreezeSchema.safeParse({
    obligationId: formData.get("obligationId"),
    freeze: freezeRaw === "true",
    reason:
      typeof formData.get("reason") === "string" &&
      (formData.get("reason") as string).trim().length > 0
        ? (formData.get("reason") as string).trim()
        : undefined,
  });

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "A valid obligation id is required.",
    };
  }

  const result = await setDisputeFreeze(
    parsed.data.obligationId,
    parsed.data.freeze,
    supportAdminActor(actor.id),
    parsed.data.reason,
  );

  if (!result.ok) {
    return {
      success: false,
      error:
        result.code === "NOT_FOUND"
          ? "The obligation could not be found — it may have been removed or the link is stale."
          : "The dispute freeze could not be updated. Support authorization is required.",
    };
  }

  revalidatePath("/dashboard/support/milestones/[id]", "page");

  return {
    success: true,
    data: undefined,
  };
}

/**
 * Execute a FULL refund of a funded, unreleased payment through the existing
 * 14E service (reconcile-first, full-amount, provider-verified). The outcome
 * is reported honestly: REFUNDED means the provider processed the refund;
 * REFUND_PENDING means it was submitted and is awaiting provider resolution.
 */
export async function executeFullRefundAction(
  _prev: ActionResult<{ status: string; outcome: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ status: string; outcome: string }>> {
  // Fail closed before anything else — the verdict, not the form, decides.
  const actor = await getSupportActor();

  if (!actor) {
    return { success: false, error: "Support authorization required." };
  }

  const parsed = supportObligationActionSchema.safeParse({
    obligationId: formData.get("obligationId"),
  });

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "A valid obligation id is required.",
    };
  }

  // NO providerOverride: that is a test seam only and is never exposed to
  // actions. Every refund gate (authorization, state, freeze, settled
  // milestones, in-flight payouts, reconcile-before-re-POST) lives in and is
  // enforced by the service itself.
  const result = await executeFullRefund(parsed.data.obligationId, supportAdminActor(actor.id));

  if (!result.ok) {
    return { success: false, error: refundErrorMessage(result.code, result.reason) };
  }

  revalidatePath("/dashboard/support/milestones/[id]", "page");

  const data: { status: string; outcome: string } = {
    outcome:
      result.status === "REFUNDED"
        ? "Refund completed — the provider has processed the full refund."
        : "Refund submitted — awaiting the provider's confirmation. The obligation stays in REFUND_PENDING until then; reconciliation will converge it.",
    status: result.status,
  };

  return { success: true, data };
}

/** Operator-safe message per existing RefundErrorCode — no internals leaked. */
function refundErrorMessage(code: string, reason: string): string {
  switch (code) {
    case "UNAUTHORIZED":
      return "Support authorization required.";
    case "NOT_FOUND":
      return "The obligation could not be found — it may have been removed or the link is stale.";
    case "PROVIDER_UNCONFIGURED":
      return "No payment provider is configured yet — the refund cannot be sent.";
    case "PROVIDER_REFERENCE_MISSING":
      return "This payment has no provider charge reference to refund against.";
    case "INVALID_STATE":
      return `This payment cannot be refunded in its current state. ${reason}`.trim();
    case "DISPUTE_FROZEN":
      return "The funds are under a dispute freeze — lift the freeze explicitly before refunding.";
    case "MILESTONE_SETTLED":
      return "A milestone of this agreement has already been settled or released — a full refund is no longer possible.";
    case "PAYOUT_IN_FLIGHT":
      return "A payout transfer is currently in flight — refund refused until it resolves.";
    case "PROVIDER_FAILED":
      return `The provider refused the refund: ${reason}`.trim();
    case "TRANSITION_CONFLICT":
      return "The provider processed the refund but the state change was refused — operator review required.";
    case "RECONCILIATION_INCONCLUSIVE":
      return "The provider's refund status could not be confirmed — the refund stays pending; retry reconciliation later.";
    case "TRANSIENT_DB_FAILURE":
      return "The refund could not be recorded — nothing was sent to the provider. Retry shortly.";
    default:
      return "The refund could not be completed. Try again or escalate.";
  }
}
