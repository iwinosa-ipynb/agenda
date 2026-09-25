"use server";

import { revalidatePath } from "next/cache";

import {
  verifyCampaignPostById,
  type VerificationActor,
} from "@/services/post-verification.service";
import { requireViewerCreatorId } from "@/services/creator.service";
import { requireViewerAdvertiserId } from "@/services/advertiser.service";
import { requireUser } from "@/lib/authz";
import type { ActionResult } from "@/types";

/**
 * Server-side trigger for post verification. Every actor is resolved from the
 * session — never from form fields — and the service re-checks ownership of
 * the post (creator → own post; advertiser → own campaign's post).
 *
 * There is no background-job architecture in this project yet, so this action
 * is the smallest clean entry point; a scheduled worker can later call
 * `verifyPendingCampaignPosts` (SYSTEM actor) from the same service.
 */
export async function verifyCampaignPostAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const postId = formData.get("postId");

  if (typeof postId !== "string" || postId.length === 0) {
    return { success: false, error: "Invalid post." };
  }

  const user = await requireUser();
  let actor: VerificationActor;

  if (user.role === "CREATOR") {
    const creatorId = await requireViewerCreatorId();
    actor = { kind: "CREATOR", creatorId };
  } else {
    const advertiserId = await requireViewerAdvertiserId();
    actor = { kind: "ADVERTISER", advertiserId };
  }

  const result = await verifyCampaignPostById(
    postId,
    actor,
    { triggeredBy: "dashboard_action" },
  );

  revalidatePath("/dashboard/posts");
  revalidatePath("/dashboard/active-campaigns");
  // Advertiser submitted-content views render per campaign detail page.
  revalidatePath("/dashboard/campaigns/[id]", "page");
  revalidatePath("/dashboard/campaigns");

  if (!result.success) {
    return result;
  }

  switch (result.data.outcome) {
    case "VERIFIED":
      return { success: true, data: undefined };
    case "REJECTED":
      return { success: false, error: "Verification failed: the post did not meet the campaign rules." };
    case "IN_PROGRESS_BY_OTHER_RUN":
      return { success: false, error: "A verification run is already in progress for this post." };
    case "NOT_FOUND":
      return { success: false, error: "Post not found." };
    case "UNAUTHORIZED":
      return { success: false, error: "You can only verify your own submissions." };
    case "PENDING_RETRY":
    default:
      return { success: false, error: result.data.reason ?? "Verification could not run right now. Try again later." };
  }
}
