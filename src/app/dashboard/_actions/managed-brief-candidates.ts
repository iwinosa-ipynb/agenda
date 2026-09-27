"use server";

import { revalidatePath } from "next/cache";

import { getSupportActor } from "@/lib/authz";
import {
  addManagedBriefCandidateForSupport,
  contactManagedBriefCandidateForSupport,
  declineManagedBriefCandidateForSupport,
  recordManagedBriefOutreachDeclinedForSupport,
  recordManagedBriefOutreachInterestedForSupport,
  removeManagedBriefCandidateForSupport,
  setManagedBriefCandidateNoteForSupport,
  setManagedBriefOutreachNoteForSupport,
  transitionManagedBriefCandidateForSupport,
} from "@/services/managed-brief.service";
import type { ActionResult } from "@/types";
import {
  managedBriefCandidateAddSchema,
  managedBriefCandidateNoteSchema,
  managedBriefCandidateRemoveSchema,
  managedBriefCandidateStatusActionSchema,
  managedBriefOutreachContactSchema,
  managedBriefOutreachNoteSchema,
  managedBriefOutreachResponseSchema,
} from "@/validation/managed-brief";

/**
 * Agenda Managed (V1, slice 3) — support sourcing candidates for a brief.
 *
 * AUTHORIZATION BOUNDARY (Stage 14D — same seam as the slice 2 review
 * transition):
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
 *      owns the state machine — forms identify the brief/candidate only;
 *      the next candidate status is derived server-side, so an invalid
 *      transition is impossible to express through these actions.
 *   4. Creator identity is referenced, never duplicated: forms carry ids of
 *      existing CreatorProfile/SocialAccount rows, and the service verifies
 *      the account belongs to the creator.
 */

/** Revalidate every surface that renders candidate data for this brief. */
function revalidateSourcing(briefId: string): void {
  revalidatePath("/dashboard/support/managed");
  revalidatePath(`/dashboard/support/managed/${briefId}`);
}

/**
 * The add form's select encodes the account + creator pair as
 * "<socialAccountId>:<creatorProfileId>". Both are plain uuid ids of EXISTING
 * records — the service re-verifies the pairing against the database, so a
 * forged or mismatched value is rejected server-side.
 */
function parseAccountOption(raw: FormDataEntryValue | null):
  | { socialAccountId: string; creatorProfileId: string }
  | null {
  if (typeof raw !== "string") {
    return null;
  }

  const separator = raw.lastIndexOf(":");

  if (separator <= 0) {
    return null;
  }

  const socialAccountId = raw.slice(0, separator);
  const creatorProfileId = raw.slice(separator + 1);

  // UUID v4 ids contain no colons, so exactly one separator must exist.
  if (creatorProfileId.includes(":")) {
    return null;
  }

  return { socialAccountId, creatorProfileId };
}

export async function addManagedBriefCandidateAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  // Fail closed before anything else — the form never decides identity.
  const actor = await getSupportActor();

  if (!actor) {
    return { success: false, error: "Support authorization required." };
  }

  const accountOption = parseAccountOption(
    formData.get("creatorAccountOption"),
  );

  if (!accountOption) {
    return { success: false, error: "Choose a creator account." };
  }

  const parsed = managedBriefCandidateAddSchema.safeParse({
    briefId: formData.get("briefId"),
    creatorProfileId: accountOption.creatorProfileId,
    socialAccountId: accountOption.socialAccountId,
    note: typeof formData.get("note") === "string" ? formData.get("note") : "",
  });

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Check the candidate form.",
    };
  }

  const result = await addManagedBriefCandidateForSupport(parsed.data);

  if (!result.success) {
    return result;
  }

  revalidateSourcing(parsed.data.briefId);

  return { success: true, data: undefined };
}

export async function transitionManagedBriefCandidateAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await getSupportActor();

  if (!actor) {
    return { success: false, error: "Support authorization required." };
  }

  const parsed = managedBriefCandidateStatusActionSchema.safeParse({
    candidateId: formData.get("candidateId"),
  });

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "A valid candidate id is required.",
    };
  }

  const result = await transitionManagedBriefCandidateForSupport(
    parsed.data.candidateId,
  );

  if (!result.success) {
    return result;
  }

  // The service returns the owning brief's id, so exactly the affected
  // surfaces revalidate.
  revalidateSourcing(result.data.briefId);

  return { success: true, data: undefined };
}

/**
 * Decline a candidate — the explicit exit from any active state. The target
 * status is fixed server-side (DECLINED), never read from the form.
 */
export async function declineManagedBriefCandidateAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await getSupportActor();

  if (!actor) {
    return { success: false, error: "Support authorization required." };
  }

  const parsed = managedBriefCandidateStatusActionSchema.safeParse({
    candidateId: formData.get("candidateId"),
  });

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "A valid candidate id is required.",
    };
  }

  const result = await declineManagedBriefCandidateForSupport(
    parsed.data.candidateId,
  );

  if (!result.success) {
    return result;
  }

  revalidateSourcing(result.data.briefId);

  return { success: true, data: undefined };
}

/**
 * Mark a candidate CONTACTED — creates the candidate's single internal
 * outreach record. INTERNAL TRACKING ONLY: nothing is sent to the creator by
 * any code path. The form carries the candidate id (and an optional internal
 * note); the target status is fixed server-side.
 */
export async function contactManagedBriefCandidateAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await getSupportActor();

  if (!actor) {
    return { success: false, error: "Support authorization required." };
  }

  const parsed = managedBriefOutreachContactSchema.safeParse({
    candidateId: formData.get("candidateId"),
    note: typeof formData.get("outreachNote") === "string" ? formData.get("outreachNote") : "",
  });

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "A valid candidate id is required.",
    };
  }

  const result = await contactManagedBriefCandidateForSupport(parsed.data);

  if (!result.success) {
    return result;
  }

  revalidateSourcing(result.data.briefId);

  return { success: true, data: undefined };
}

/**
 * Record the creator as INTERESTED. The target is fixed server-side — the
 * form can never name a raw status.
 */
export async function recordOutreachInterestedAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await getSupportActor();

  if (!actor) {
    return { success: false, error: "Support authorization required." };
  }

  const parsed = managedBriefOutreachResponseSchema.safeParse({
    candidateId: formData.get("candidateId"),
    note: typeof formData.get("outreachNote") === "string" ? formData.get("outreachNote") : "",
  });

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "A valid candidate id is required.",
    };
  }
  
  const result = await recordManagedBriefOutreachInterestedForSupport(parsed.data);

  if (!result.success) {
    return result;
  }

  revalidateSourcing(result.data.briefId);

  return { success: true, data: undefined };
}

/**
 * Record the creator as DECLINED. The target is fixed server-side — the
 * form can never name a raw status.
 */
export async function recordOutreachDeclinedAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await getSupportActor();

  if (!actor) {
    return { success: false, error: "Support authorization required." };
  }

  const parsed = managedBriefOutreachResponseSchema.safeParse({
    candidateId: formData.get("candidateId"),
    note: typeof formData.get("outreachNote") === "string" ? formData.get("outreachNote") : "",
  });

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "A valid candidate id is required.",
    };
  }

  const result = await recordManagedBriefOutreachDeclinedForSupport(parsed.data);

  if (!result.success) {
    return result;
  }

  revalidateSourcing(result.data.briefId);

  return { success: true, data: undefined };
}

/** Update the outreach record's internal note (support-eyes only). */
export async function setOutreachNoteAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await getSupportActor();

  if (!actor) {
    return { success: false, error: "Support authorization required." };
  }

  const parsed = managedBriefOutreachNoteSchema.safeParse({
    candidateId: formData.get("candidateId"),
    note: typeof formData.get("outreachNote") === "string" ? formData.get("outreachNote") : "",
  });

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Check the note.",
    };
  }

  const result = await setManagedBriefOutreachNoteForSupport(parsed.data);

  if (!result.success) {
    return result;
  }

  revalidateSourcing(result.data.briefId);

  return { success: true, data: undefined };
}

export async function setManagedBriefCandidateNoteAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await getSupportActor();

  if (!actor) {
    return { success: false, error: "Support authorization required." };
  }

  const parsed = managedBriefCandidateNoteSchema.safeParse({
    candidateId: formData.get("candidateId"),
    note: typeof formData.get("note") === "string" ? formData.get("note") : "",
  });

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Check the note.",
    };
  }

  const result = await setManagedBriefCandidateNoteForSupport(parsed.data);

  if (!result.success) {
    return result;
  }

  revalidateSourcing(result.data.briefId);

  return { success: true, data: undefined };
}

export async function removeManagedBriefCandidateAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await getSupportActor();

  if (!actor) {
    return { success: false, error: "Support authorization required." };
  }

  const parsed = managedBriefCandidateRemoveSchema.safeParse({
    candidateId: formData.get("candidateId"),
  });

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "A valid candidate id is required.",
    };
  }

  const result = await removeManagedBriefCandidateForSupport(
    parsed.data.candidateId,
  );

  if (!result.success) {
    return result;
  }

  revalidateSourcing(result.data.briefId);

  return { success: true, data: undefined };
}
