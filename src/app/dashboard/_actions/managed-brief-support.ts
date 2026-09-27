"use server";

import { revalidatePath } from "next/cache";

import { getSupportActor } from "@/lib/authz";
import { transitionManagedBriefForSupport } from "@/services/managed-brief.service";
import type { ActionResult } from "@/types";
import { managedBriefReviewActionSchema } from "@/validation/managed-brief";

/**
 * Agenda Managed (V1, slice 2) — advance a managed brief through support
 * review (SUBMITTED → IN_REVIEW → CLOSED).
 *
 * AUTHORIZATION BOUNDARY (Stage 14D — same seam as recordSupportDecision):
 *   1. The actor id comes ONLY from the server session via getSupportActor();
 *      a client can never supply or forge it, and no form field influences
 *      identity or permissions.
 *   2. The caller must be a SUPPORT session whose user is on the
 *      operator-maintained support roster (User.supportRosterMember —
 *      writable only by SQL/operations, re-read fresh from the database on
 *      every request, so revocation ends access immediately). Fail-closed:
 *      anonymous callers, creators, advertisers and roster-less SUPPORT
 *      sessions are all refused.
 *   3. The service re-checks roster authorization (defense in depth) and
 *      owns the state machine — the client identifies the brief only; the
 *      next status is derived server-side, so an invalid transition is
 *      impossible to express through this action.
 */
export async function transitionManagedBriefAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  // Fail closed before anything else — the verdict, not the form, decides.
  const actor = await getSupportActor();

  if (!actor) {
    return { success: false, error: "Support authorization required." };
  }

  const parsed = managedBriefReviewActionSchema.safeParse({
    briefId: formData.get("briefId"),
  });

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "A valid brief id is required.",
    };
  }

  const result = await transitionManagedBriefForSupport(parsed.data.briefId);

  if (!result.success) {
    return result;
  }

  revalidatePath("/dashboard/support/managed");
  revalidatePath(`/dashboard/support/managed/${parsed.data.briefId}`);
  revalidatePath("/dashboard/managed");
  revalidatePath(`/dashboard/managed/${parsed.data.briefId}`);

  return { success: true, data: undefined };
}
