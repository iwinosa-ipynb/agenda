"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@/lib/auth";
import type { ActionResult } from "@/types";
import {
  isSupportActor,
  recordSupportDecision,
} from "@/services/payments/milestone-review.service";
import { supportDecisionSchema } from "@/validation/milestones";

/**
 * Stage 13B — support decision action.
 *
 * AUTHORIZATION BOUNDARY (documented per the 13B audit):
 *   1. The actor id comes ONLY from the server session (`auth()`); a client
 *      can never supply or forge it.
 *   2. Authentication is NOT authorization: the session user must ALSO be on
 *      the operator-maintained support roster (User.supportRosterMember —
 *      writable only by SQL/operations, never by any client path). The check
 *      is re-enforced inside the service. Fail-closed: an empty roster
 *      authorizes nobody, so ordinary advertisers and creators — even fully
 *      authenticated ones — cannot invoke support release/cancellation.
 *   3. When the Stage 14 admin role architecture lands, this becomes
 *      requireRole("ADMIN") (or its successor); nothing else changes.
 */
export async function recordSupportDecisionAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "You must be signed in." };
  }

  // Authorization ≠ authentication: roster membership is required, on top of
  // the session. The service re-checks this (defense in depth).
  const onRoster = await isSupportActor(session.user.id);

  if (!onRoster) {
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
    userId: session.user.id,
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
