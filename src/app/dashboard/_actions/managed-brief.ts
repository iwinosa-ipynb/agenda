"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireViewerAdvertiserId } from "@/services/advertiser.service";
import { convertSelectedCandidateToDraftCampaign } from "@/services/managed-brief-conversion.service";
import { createManagedBrief } from "@/services/managed-brief.service";
import type { ActionResult } from "@/types";
import {
  parseManagedBriefConversionForm,
  parseManagedBriefForm,
} from "@/validation/managed-brief";

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

/**
 * Agenda Managed (V1, slice 5) — convert a SELECTED sourcing candidate into
 * a DRAFT marketplace Campaign.
 *
 * Authorization: the advertiser id comes ONLY from the server session via
 * requireViewerAdvertiserId (role ADVERTISER + profile lookup) — no form
 * field can supply or override it, and the service re-verifies the brief's
 * ownership inside its query. Support cannot act through this action (their
 * sessions are not ADVERTISER and never resolve an advertiser profile here).
 *
 * The form carries the campaign fields the brief lacks (title, category,
 * target location, explicit budget, dates, creator slots). The brief's
 * informational budget is never used; the creator's quote is never asked
 * for here — the selected creator applies themselves, per the locked
 * product flow.
 */
export async function convertSelectedCandidateAction(
  _prev: ActionResult<{
    campaignId: string;
    candidateId: string;
    briefId: string;
  }> | null,
  formData: FormData,
): Promise<ActionResult<{
  campaignId: string;
  candidateId: string;
  briefId: string;
}>> {
  // Identity from the session, never from the submitted form.
  const advertiserId = await requireViewerAdvertiserId();

  const parsed = parseManagedBriefConversionForm({
    briefId: formData.get("briefId"),
    candidateId: formData.get("candidateId"),
    title: formData.get("title"),
    category: formData.get("category"),
    targetLocation: formData.get("targetLocation"),
    minimumFollowers: formData.get("minimumFollowers"),
    maxCreators: formData.get("maxCreators"),
    budget: formData.get("budget"),
    startDate: formData.get("startDate"),
    endDate: formData.get("endDate"),
    applicationDeadline: formData.get("applicationDeadline"),
    contentRequirements: formData.get("contentRequirements"),
    rules: formData.get("rules"),
  });

  if (!parsed.success) {
    return {
      success: false,
      error: "Please check the highlighted fields.",
      fieldErrors: parsed.fieldErrors,
    };
  }

  const result = await convertSelectedCandidateToDraftCampaign(
    advertiserId,
    parsed.data,
  );

  if (!result.success) {
    return { success: false, error: result.error };
  }

  revalidatePath(`/dashboard/managed/${parsed.data.briefId}`);
  revalidatePath("/dashboard/managed");
  revalidatePath("/dashboard/campaigns");

  return { success: true, data: result.data };
}
