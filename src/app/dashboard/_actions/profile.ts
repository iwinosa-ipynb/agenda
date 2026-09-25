"use server";

import { revalidatePath } from "next/cache";

import { getViewerCreator, updateCreatorProfile } from "@/services/creator.service";
import type { ActionResult } from "@/types";
import { creatorProfileSchema } from "@/validation/creator";
import { flattenFieldErrors } from "@/validation/errors";

export async function updateCreatorProfileAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  // Identity comes from the session, never from the submitted form.
  const { userId } = await getViewerCreator();

  const parsed = creatorProfileSchema.safeParse({
    displayName: formData.get("displayName"),
    username: formData.get("username"),
    bio: formData.get("bio") ?? "",
    location: formData.get("location") ?? "",
    state: formData.get("state") ?? "",
    country: formData.get("country") ?? "",
    category: formData.get("category") ?? "",
    followerCount: formData.get("followerCount") ?? "0",
    profileImage: formData.get("profileImage") ?? "",
  });

  if (!parsed.success) {
    return {
      success: false,
      error: "Please check the highlighted fields.",
      fieldErrors: flattenFieldErrors(parsed.error),
    };
  }

  const result = await updateCreatorProfile(userId, parsed.data);

  if (!result.success) {
    return result;
  }

  revalidatePath("/dashboard/profile");
  revalidatePath("/dashboard");

  return { success: true, data: undefined };
}
