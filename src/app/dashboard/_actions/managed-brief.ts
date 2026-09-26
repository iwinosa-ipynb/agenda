"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireViewerAdvertiserId } from "@/services/advertiser.service";
import { createManagedBrief } from "@/services/managed-brief.service";
import type { ActionResult } from "@/types";
import { parseManagedBriefForm } from "@/validation/managed-brief";

/**
 * Agenda Managed (V1) — submit a private managed-marketing brief.
 *
 * Authorization: the advertiser id comes from the server session via
 * requireViewerAdvertiserId (role ADVERTISER + profile lookup) — never from
 * the form. Validation is structural (Zod); status is server-owned. On
 * success the caller is redirected to their brief list.
 */
export async function createManagedBriefAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  // Identity from the session, never from the submitted form.
  const advertiserId = await requireViewerAdvertiserId();

  const parsed = parseManagedBriefForm({
    campaignGoal: formData.get("campaignGoal"),
    description: formData.get("description"),
    budget: formData.get("budget"),
    currency: formData.get("currency"),
    targetAudience: formData.get("targetAudience"),
    targetPlatforms: formData.getAll("targetPlatforms"),
    creatorRequirements: formData.get("creatorRequirements") ?? "",
  });

  if (!parsed.success) {
    return {
      success: false,
      error: "Please check the highlighted fields.",
      fieldErrors: parsed.fieldErrors,
    };
  }

  const result = await createManagedBrief(advertiserId, parsed.data);

  if (!result.success) {
    return result;
  }

  revalidatePath("/dashboard/managed");
  revalidatePath("/dashboard");

  // Redirect on success; the state never needs to reach the client.
  redirect(`/dashboard/managed/${result.data.briefId}`);
}
