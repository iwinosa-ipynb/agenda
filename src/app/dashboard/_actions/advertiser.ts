"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  createCampaign,
  reviewApplication,
  transitionCampaign,
  updateAdvertiserProfile,
  updateCampaign,
} from "@/services/advertiser.service";
import { requireViewerAdvertiserId } from "@/services/advertiser.service";
import type { ActionResult } from "@/types";
import {
  advertiserProfileSchema,
  parseCampaignForm,
} from "@/validation/advertiser";
import { reviewApplicationSchema } from "@/validation/campaign";
import { flattenFieldErrors } from "@/validation/errors";

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export async function updateAdvertiserProfileAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  // Identity comes from the session, never from the submitted form.
  const userId = await requireViewerAdvertiserId();

  const parsed = advertiserProfileSchema.safeParse({
    companyName: formData.get("companyName"),
    companyDescription: formData.get("companyDescription") ?? "",
    location: formData.get("location") ?? "",
    state: formData.get("state") ?? "",
    country: formData.get("country") ?? "",
    website: formData.get("website") ?? "",
    logoUrl: formData.get("logoUrl") ?? "",
  });

  if (!parsed.success) {
    return {
      success: false,
      error: "Please check the highlighted fields.",
      fieldErrors: flattenFieldErrors(parsed.error),
    };
  }

  const result = await updateAdvertiserProfile(userId, parsed.data);

  if (!result.success) {
    return result;
  }

  revalidatePath("/dashboard/profile");
  revalidatePath("/dashboard");

  return { success: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

function readCampaignForm(formData: FormData) {
  return {
    title: formData.get("title"),
    description: formData.get("description"),
    category: formData.get("category"),
    platform: formData.get("platform"),
    targetCountry: formData.get("targetCountry"),
    targetLocation: formData.get("targetLocation"),
    minimumFollowers: formData.get("minimumFollowers"),
    maxCreators: formData.get("maxCreators") ?? null,
    tags: formData.get("tags") ?? null,
    budget: formData.get("budget"),
    startDate: formData.get("startDate"),
    endDate: formData.get("endDate"),
    applicationDeadline: formData.get("applicationDeadline"),
    contentRequirements: formData.get("contentRequirements"),
    rules: formData.get("rules"),
  };
}

/**
 * Create a campaign. The `intent` field decides between "save draft" and
 * "create + publish" — both paths run the same structural validation, and the
 * publish path additionally re-validates completeness server-side.
 */
export async function createCampaignAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const advertiserId = await requireViewerAdvertiserId();

  const intent = formData.get("intent") === "publish" ? "publish" : "draft";

  const parsed = parseCampaignForm(readCampaignForm(formData), intent);

  if (!parsed.success) {
    return {
      success: false,
      error: "Please check the highlighted fields.",
      fieldErrors: parsed.fieldErrors,
    };
  }

  const result = await createCampaign(
    advertiserId,
    parsed.data,
    intent === "publish" ? "PUBLISHED" : "DRAFT",
  );

  if (!result.success) {
    return result;
  }

  revalidatePath("/dashboard/campaigns");
  revalidatePath("/dashboard");

  // Redirect on success; the state never needs to reach the client.
  redirect(`/dashboard/campaigns/${result.data.campaignId}`);
}

/**
 * Save changes to an owned campaign. Ownership is enforced inside the service
 * update where-clause, never from client input.
 */
export async function updateCampaignAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const advertiserId = await requireViewerAdvertiserId();

  const campaignId = formData.get("campaignId");

  if (typeof campaignId !== "string") {
    return { success: false, error: "Invalid campaign." };
  }

  const parsed = parseCampaignForm(readCampaignForm(formData));

  if (!parsed.success) {
    return {
      success: false,
      error: "Please check the highlighted fields.",
      fieldErrors: parsed.fieldErrors,
    };
  }

  const result = await updateCampaign(advertiserId, campaignId, parsed.data);

  if (!result.success) {
    return result;
  }

  revalidatePath("/dashboard/campaigns");
  revalidatePath(`/dashboard/campaigns/${campaignId}`);

  redirect(`/dashboard/campaigns/${campaignId}`);
}

function revalidateCampaign(campaignId: string): void {
  revalidatePath("/dashboard/campaigns");
  revalidatePath(`/dashboard/campaigns/${campaignId}`);
  revalidatePath("/dashboard/campaigns");
  revalidatePath("/dashboard");
}

/**
 * Publish a draft. Completeness is re-validated server-side inside the
 * transition, so an incomplete campaign can never reach the marketplace.
 */
export async function publishCampaignAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const advertiserId = await requireViewerAdvertiserId();

  const campaignId = formData.get("campaignId");

  if (typeof campaignId !== "string") {
    return { success: false, error: "Invalid campaign." };
  }

  const result = await transitionCampaign(advertiserId, campaignId, "PUBLISH");

  if (!result.success) {
    return result;
  }

  revalidateCampaign(campaignId);

  return { success: true, data: undefined };
}

/**
 * Stop accepting new applications on a published campaign. Existing pending
 * applications can still be accepted while slots/budget allow (Stage 12).
 */
export async function closeApplicationsAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const advertiserId = await requireViewerAdvertiserId();

  const campaignId = formData.get("campaignId");

  if (typeof campaignId !== "string") {
    return { success: false, error: "Invalid campaign." };
  }

  const result = await transitionCampaign(
    advertiserId,
    campaignId,
    "CLOSE_APPLICATIONS",
  );

  if (!result.success) {
    return result;
  }

  revalidateCampaign(campaignId);

  return { success: true, data: undefined };
}

/** Mark a campaign with closed applications as in progress. */
export async function startCampaignAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const advertiserId = await requireViewerAdvertiserId();

  const campaignId = formData.get("campaignId");

  if (typeof campaignId !== "string") {
    return { success: false, error: "Invalid campaign." };
  }

  const result = await transitionCampaign(advertiserId, campaignId, "START");

  if (!result.success) {
    return result;
  }

  revalidateCampaign(campaignId);

  return { success: true, data: undefined };
}

/** Mark an in-progress campaign as completed. */
export async function completeCampaignAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const advertiserId = await requireViewerAdvertiserId();

  const campaignId = formData.get("campaignId");

  if (typeof campaignId !== "string") {
    return { success: false, error: "Invalid campaign." };
  }

  const result = await transitionCampaign(advertiserId, campaignId, "COMPLETE");

  if (!result.success) {
    return result;
  }

  revalidateCampaign(campaignId);

  return { success: true, data: undefined };
}

/** Cancel a campaign that has not started yet. */
export async function cancelCampaignAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const advertiserId = await requireViewerAdvertiserId();

  const campaignId = formData.get("campaignId");

  if (typeof campaignId !== "string") {
    return { success: false, error: "Invalid campaign." };
  }

  const result = await transitionCampaign(advertiserId, campaignId, "CANCEL");

  if (!result.success) {
    return result;
  }

  revalidateCampaign(campaignId);

  return { success: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

/**
 * Accept or reject an application. The service verifies the full ownership
 * chain (application → campaign → advertiser) inside the update.
 */
export async function reviewApplicationAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const advertiserId = await requireViewerAdvertiserId();

  const parsed = reviewApplicationSchema.safeParse({
    applicationId: formData.get("applicationId"),
    decision: formData.get("decision"),
  });

  if (!parsed.success) {
    return {
      success: false,
      error: "Invalid request.",
      fieldErrors: flattenFieldErrors(parsed.error),
    };
  }

  const result = await reviewApplication(
    advertiserId,
    parsed.data.applicationId,
    parsed.data.decision,
  );

  if (!result.success) {
    return result;
  }

  revalidatePath("/dashboard/applications");
  revalidatePath(`/dashboard/applications/${parsed.data.applicationId}`);
  revalidatePath("/dashboard");

  return { success: true, data: undefined };
}
