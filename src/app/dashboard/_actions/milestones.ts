"use server";

import { revalidatePath } from "next/cache";

import type { ActionResult } from "@/types";
import {
  confirmMilestoneRelease,
  requestMilestoneCorrection,
  submitMilestoneCorrection,
  escalateMilestoneToSupport,
} from "@/services/payments/milestone-review.service";
import { submitMilestonePost } from "@/services/payments/milestone-submission.service";
import { parseCampaignPost } from "@/validation/post";
import { getViewerAdvertiser } from "@/services/advertiser.service";
import { getViewerCreator } from "@/services/creator.service";
import {
  confirmMilestoneReleaseSchema,
  requestMilestoneCorrectionSchema,
  submitMilestoneCorrectionSchema,
  escalateMilestoneSchema,
} from "@/validation/milestones";

/**
 * Stage 13B server actions. Identity ALWAYS comes from the server session
 * (never the form); ids and text come from the form and are validated by the
 * schemas, which carry no amount, timer or status fields.
 */

function actionError(error: string): ActionResult<undefined> {
  return { success: false, error };
}

export async function confirmMilestoneReleaseAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const { profile, userId } = await getViewerAdvertiser();

  const parsed = confirmMilestoneReleaseSchema.safeParse({
    milestoneId: formData.get("milestoneId"),
  });

  if (!parsed.success) {
    return actionError("Invalid milestone reference.");
  }

  const result = await confirmMilestoneRelease(parsed.data.milestoneId, {
    advertiserProfileId: profile.id,
    userId,
  });

  if (!result.ok) {
    return actionError(result.reason);
  }

  if ("settled" in result && result.settled === false && result.settlementCode) {
    return actionError(result.settlementReason ?? "Release confirmed but settlement could not start yet.");
  }

  revalidatePath("/dashboard/agreements");
  revalidatePath("/dashboard/posts");
  revalidatePath("/dashboard");

  return { success: true, data: undefined };
}

export async function requestMilestoneCorrectionAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const { profile, userId } = await getViewerAdvertiser();

  const parsed = requestMilestoneCorrectionSchema.safeParse({
    milestoneId: formData.get("milestoneId"),
    note: formData.get("note"),
  });

  if (!parsed.success) {
    return actionError(parsed.error.issues[0]?.message ?? "Please check the correction request.");
  }

  const result = await requestMilestoneCorrection(parsed.data.milestoneId, {
    advertiserProfileId: profile.id,
    userId,
  }, { note: parsed.data.note });

  if (!result.ok) {
    return actionError(result.reason);
  }

  revalidatePath("/dashboard/agreements");
  revalidatePath("/dashboard/posts");

  return { success: true, data: undefined };
}

export async function submitMilestoneCorrectionAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const { profile, userId } = await getViewerCreator();

  const parsed = submitMilestoneCorrectionSchema.safeParse({
    milestoneId: formData.get("milestoneId"),
    postId: formData.get("postId"),
  });

  if (!parsed.success) {
    return actionError("Please check the correction submission.");
  }

  const result = await submitMilestoneCorrection(parsed.data.milestoneId, {
    creatorProfileId: profile.id,
    userId,
  }, parsed.data.postId);

  if (!result.ok) {
    return actionError(result.reason);
  }

  revalidatePath("/dashboard/posts");
  revalidatePath("/dashboard/agreements");

  return { success: true, data: undefined };
}

/**
 * Stage 13C — creator submits a published post against a SPECIFIC milestone.
 * Identity comes from the session (never a client field); eligibility,
 * funding and duplicate checks all run server-side in the service, and the
 * post is verified through the existing Stage 9 pipeline.
 */
export async function submitMilestonePostAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const { profile, userId } = await getViewerCreator();

  const milestoneId = formData.get("milestoneId");

  if (typeof milestoneId !== "string" || milestoneId.length === 0) {
    return actionError("Invalid milestone.");
  }

  const parsed = parseCampaignPost({
    platform: formData.get("platform"),
    postUrl: formData.get("postUrl"),
    caption: formData.get("caption") ?? "",
    creatorNote: formData.get("creatorNote") ?? "",
  });

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.fieldErrors.postUrl?.[0] ?? parsed.fieldErrors.platform?.[0] ?? "Please check the highlighted fields.",
      fieldErrors: parsed.fieldErrors,
    };
  }

  const result = await submitMilestonePost(milestoneId, {
    creatorProfileId: profile.id,
    userId,
  }, parsed.data);

  if (!result.ok) {
    return actionError(result.reason);
  }

  revalidatePath("/dashboard/agreements");
  revalidatePath("/dashboard/posts");

  return { success: true, data: undefined };
}

export async function escalateMilestoneAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const milestoneId = formData.get("milestoneId");
  const role = formData.get("actorRole");

  const parsed = escalateMilestoneSchema.safeParse({
    milestoneId,
    reason: formData.get("reason"),
  });

  if (!parsed.success) {
    return actionError(parsed.error.issues[0]?.message ?? "Please describe the issue.");
  }

  if (role === "ADVERTISER") {
    const { profile, userId } = await getViewerAdvertiser();

    const result = await escalateMilestoneToSupport(parsed.data.milestoneId, {
      kind: "ADVERTISER",
      advertiserProfileId: profile.id,
      userId,
    }, { reason: parsed.data.reason });

    if (!result.ok) {
      return actionError(result.reason);
    }
  } else if (role === "CREATOR") {
    const { profile, userId } = await getViewerCreator();

    const result = await escalateMilestoneToSupport(parsed.data.milestoneId, {
      kind: "CREATOR",
      creatorProfileId: profile.id,
      userId,
    }, { reason: parsed.data.reason });

    if (!result.ok) {
      return actionError(result.reason);
    }
  } else {
    return actionError("Invalid escalation request.");
  }

  revalidatePath("/dashboard/agreements");
  revalidatePath("/dashboard/posts");

  return { success: true, data: undefined };
}
