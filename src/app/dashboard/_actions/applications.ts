"use server";

import { revalidatePath } from "next/cache";

import {
  applyToCampaign,
  withdrawApplication,
} from "@/services/application.service";
import { requireViewerCreatorId } from "@/services/creator.service";
import type { ActionResult } from "@/types";
import {
  applyToCampaignSchema,
  withdrawApplicationSchema,
} from "@/validation/campaign";
import { flattenFieldErrors } from "@/validation/errors";

export async function applyToCampaignAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const creatorId = await requireViewerCreatorId();

  const parsed = applyToCampaignSchema.safeParse({
    campaignId: formData.get("campaignId"),
    quoteAmount: formData.get("quoteAmount"),
    currency: formData.get("currency") ?? "NGN",
    message: formData.get("message") ?? undefined,
  });

  if (!parsed.success) {
    return {
      success: false,
      error: "Please check the highlighted fields.",
      fieldErrors: flattenFieldErrors(parsed.error),
    };
  }

  const result = await applyToCampaign(creatorId, parsed.data);

  if (!result.success) {
    return result;
  }

  revalidatePath(`/dashboard/campaigns/${parsed.data.campaignId}`);
  revalidatePath("/dashboard/applications");
  revalidatePath("/dashboard");

  return { success: true, data: undefined };
}

export async function withdrawApplicationAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const creatorId = await requireViewerCreatorId();

  const parsed = withdrawApplicationSchema.safeParse({
    applicationId: formData.get("applicationId"),
  });

  if (!parsed.success) {
    return { success: false, error: "Invalid application." };
  }

  const result = await withdrawApplication(
    creatorId,
    parsed.data.applicationId,
  );

  if (!result.success) {
    return result;
  }

  revalidatePath("/dashboard/applications");
  revalidatePath("/dashboard");

  return { success: true, data: undefined };
}
