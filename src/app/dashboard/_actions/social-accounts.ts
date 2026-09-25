"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireViewerCreatorId } from "@/services/creator.service";
import {
  connectPlatformAccount,
  createSocialAccount,
  deleteSocialAccount,
  disconnectPlatformAccount,
} from "@/services/social-account.service";
import type { ActionResult } from "@/types";
import { socialAccountSchema } from "@/validation/creator";
import { flattenFieldErrors } from "@/validation/errors";

const removeSchema = z.object({
  accountId: z.uuid({ message: "Invalid account." }),
});

const disconnectSchema = z.object({
  platform: z.enum(["TIKTOK", "X"], {
    message: "Invalid platform.",
  }),
});

export async function addSocialAccountAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const creatorId = await requireViewerCreatorId();

  const parsed = socialAccountSchema.safeParse({
    platform: formData.get("platform"),
    username: formData.get("username"),
    profileUrl: formData.get("profileUrl"),
  });

  if (!parsed.success) {
    return {
      success: false,
      error: "Please check the highlighted fields.",
      fieldErrors: flattenFieldErrors(parsed.error),
    };
  }

  const result = await createSocialAccount(creatorId, parsed.data);

  if (!result.success) {
    return result;
  }

  revalidatePath("/dashboard/social-accounts");
  revalidatePath("/dashboard/profile");
  revalidatePath("/dashboard");

  return { success: true, data: undefined };
}

export async function removeSocialAccountAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const creatorId = await requireViewerCreatorId();

  const parsed = removeSchema.safeParse({
    accountId: formData.get("accountId"),
  });

  if (!parsed.success) {
    return { success: false, error: "Invalid account." };
  }

  const result = await deleteSocialAccount(creatorId, parsed.data.accountId);

  if (!result.success) {
    return result;
  }

  revalidatePath("/dashboard/social-accounts");
  revalidatePath("/dashboard/profile");
  revalidatePath("/dashboard");

  return { success: true, data: undefined };
}

/**
 * Remove a creator's OAuth connection for one platform. The platform comes
 * from the form (a closed enum), the creator from the session — no client
 * field can target another creator's account. Tokens and the platform
 * identity are cleared server-side by the service.
 */
export async function disconnectPlatformAccountAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const creatorId = await requireViewerCreatorId();

  const parsed = disconnectSchema.safeParse({
    platform: formData.get("platform"),
  });

  if (!parsed.success) {
    return { success: false, error: "Invalid platform." };
  }

  const result = await disconnectPlatformAccount(creatorId, parsed.data.platform);

  if (!result.success) {
    return result;
  }

  revalidatePath("/dashboard/social-accounts");
  revalidatePath("/dashboard/profile");
  revalidatePath("/dashboard");

  return { success: true, data: undefined };
}

// Re-exported for the OAuth callback routes' shared linking entry point; the
// action layer keeps a single import site for the connect service.
export { connectPlatformAccount };
