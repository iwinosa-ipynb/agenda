"use server";

import { revalidatePath } from "next/cache";

import { submitCampaignPost } from "@/services/post.service";
import { requireViewerCreatorId } from "@/services/creator.service";
import type { ActionResult } from "@/types";
import { parseCampaignPost } from "@/validation/post";

export async function submitCampaignPostAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  // Identity comes from the session, never from the submitted form.
  const creatorId = await requireViewerCreatorId();

  const campaignId = formData.get("campaignId");

  if (typeof campaignId !== "string" || campaignId.length === 0) {
    return { success: false, error: "Invalid campaign." };
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
      error: "Please check the highlighted fields.",
      fieldErrors: parsed.fieldErrors,
    };
  }

  const result = await submitCampaignPost(creatorId, campaignId, parsed.data);

  if (!result.success) {
    return result;
  }

  revalidatePath(`/dashboard/active-campaigns/${campaignId}/submit`);
  revalidatePath("/dashboard/active-campaigns");
  revalidatePath("/dashboard/posts");
  revalidatePath("/dashboard");

  return { success: true, data: undefined };
}
