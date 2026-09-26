"use server";

import { revalidatePath } from "next/cache";

import { getSupportActor } from "@/lib/authz";
import type { ActionResult } from "@/types";
import {
  recordSupportDecision,
} from "@/services/payments/milestone-review.service";
import { supportDecisionSchema } from "@/validation/milestones";

/**
 * Stage 13B support decision action — Stage 14D authorization.
 *
 * AUTHORIZATION BOUNDARY (Stage 14D):
 *   1. The actor id comes ONLY from the server session (`auth()`); a client
 *      can never supply or forge it.
 *   2. The caller must pass the Stage 14D Support guard: a SUPPORT session
 *      whose user is on the operator-maintained support roster
 *      (User.supportRosterMember — writable only by SQL/operations, never by
 *      any client path; the JWT role claim alone is not sufficient because
 *      the roster is re-read fresh from the database on every request).
 *      Fail-closed: an empty roster authorizes nobody, so ordinary
 *      advertisers and creators — even fully authenticated ones — cannot
 *      invoke support release/cancellation.
 *   3. The service re-checks roster authorization (defense in depth);
 *      nothing else about the decision flow changes.
 */
export async function recordSupportDecisionAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await getSupportActor();

  if (!actor) {
    return { success: false, error: "Support authorization required." };
  }

  const evidenceRaw = formData.get("evidenceRefs");

  const parsed = supportDecisionSchema.safeParse({
    milestoneId: formData.get("milestoneId"),
    decision: formData.get("decision"),
    reason: formData.get("reason"),
    evidenceRefs:
      typeof evidenceRaw === "string" && evidenceRaw.trim().length > 0
        ? evidenceRaw.split(",").map((ref) => ref.trim()).filter(Boolean)
        : undefined,
  });

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Please check the decision form.",
    };
  }

  const result = await recordSupportDecision(parsed.data.milestoneId, {
    authenticated: true,
    userId: actor.id,
    source: "support-ui",
  }, {
    decision: parsed.data.decision,
    reason: parsed.data.reason,
    evidenceRefs: parsed.data.evidenceRefs,
  });

  if (!result.ok) {
    return { success: false, error: result.reason };
  }

  if (result.settled === false && result.settlementCode) {
    return {
      success: false,
      error: result.settlementReason ?? "Decision recorded but settlement could not start yet.",
    };
  }

  revalidatePath(`/dashboard/support/milestones/${parsed.data.milestoneId}`);
  revalidatePath("/dashboard/agreements");

  return { success: true, data: undefined };
}
