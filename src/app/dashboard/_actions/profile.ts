"use server";

import { revalidatePath } from "next/cache";
import { del } from "@vercel/blob";

import { isVercelBlobUrl } from "@/lib/profile-photo";
import { getViewerCreator, updateCreatorProfile } from "@/services/creator.service";
import type { ActionResult } from "@/types";
import { creatorProfileSchema } from "@/validation/creator";
import { flattenFieldErrors } from "@/validation/errors";

/**
 * Best-effort delete of a superseded profile image. Only our own Vercel Blob
 * public URLs are ever deleted (never an arbitrary external URL), and a
 * cleanup failure must never fail the profile save.
 */
async function deletePreviousBlob(url: string | null): Promise<void> {
  if (!url || !isVercelBlobUrl(url)) {
    return;
  }

  try {
    await del(url);
  } catch (error) {
    console.error("profile photo cleanup failed", error);
  }
}

export async function updateCreatorProfileAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  // Identity comes from the session, never from the submitted form.
  const { userId, profile } = await getViewerCreator();

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

  // Replaced or removed photo: delete the previous Blob so abandoned images
  // don't accumulate. Only runs after a successful save.
  const previousImage = profile.profileImage;
  const nextImage = parsed.data.profileImage ?? null;

  if (previousImage && previousImage !== nextImage) {
    await deletePreviousBlob(previousImage);
  }

  revalidatePath("/dashboard/profile");
  revalidatePath("/dashboard");

  return { success: true, data: undefined };
}
