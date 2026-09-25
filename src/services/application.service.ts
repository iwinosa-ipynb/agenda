import "server-only";

import type { Prisma } from "@/generated/prisma/client";

import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { prisma } from "@/lib/prisma";
import { toMoneyString } from "@/lib/pricing-math";
import {
  getCampaignQuoteGuidance,
  type PricingGuidance,
} from "@/services/creator-pricing-guidance.service";
import type {
  ActionResult,
  ActiveCampaignSummary,
  ApplicationSummary,
} from "@/types";

/**
 * Stage 12 — creator applications with creator-controlled pricing.
 *
 * Every rule is re-checked server-side; the client can only ever supply the
 * campaign id, its own quote and a proposal message. Status, identity and
 * money handling are resolved here.
 *
 * Application rules:
 *   - authenticated creator (session-resolved upstream)
 *   - verified Agenda email (Stage 10 gate, DB-checked)
 *   - a connected social account on the campaign's platform (OAuth-verified
 *     identity; a claimed-but-unconnected handle is not enough to apply)
 *   - campaign must be PUBLISHED and before its application deadline
 *   - cannot apply to own campaign (as an advertiser)
 *   - one application per creator per campaign (DB unique constraint)
 *   - quote validated: shape/bounds by schema, currency/campaign rules here
 */

/** Statuses a creator may re-apply after. Only WITHDRAWN frees the slot. */
const REAPPLICABLE_STATUSES = ["WITHDRAWN"] as const;

export async function getCreatorApplicationForCampaign(
  creatorId: string,
  campaignId: string,
): Promise<{ id: string; status: ApplicationSummary["status"] } | null> {
  const application = await prisma.campaignApplication.findUnique({
    where: { campaignId_creatorId: { campaignId, creatorId } },
    select: { id: true, status: true },
  });

  return application;
}

/**
 * Pricing guidance for the apply form. Re-exported through this service so
 * the action layer has a single import point for application concerns.
 */
export async function getQuoteGuidance(
  campaignId: string,
): Promise<PricingGuidance> {
  return getCampaignQuoteGuidance(campaignId);
}

export async function listCreatorApplications(
  creatorId: string,
): Promise<ApplicationSummary[]> {
  const applications = await prisma.campaignApplication.findMany({
    where: { creatorId },
    orderBy: { createdAt: "desc" },
    include: {
      campaign: {
        select: {
          id: true,
          title: true,
          platform: true,
          category: true,
          status: true,
          applicationDeadline: true,
          currency: true,
          advertiser: { select: { companyName: true } },
        },
      },
    },
  });

  return applications.map((application) => ({
    id: application.id,
    status: application.status,
    message: application.message,
    quoteAmount: application.quoteAmount,
    currency: application.currency,
    createdAt: application.createdAt,
    campaign: {
      id: application.campaign.id,
      title: application.campaign.title,
      platform: application.campaign.platform,
      category: application.campaign.category,
      status: application.campaign.status,
      applicationDeadline: application.campaign.applicationDeadline,
      currency: application.campaign.currency,
    },
    advertiser: {
      companyName: application.campaign.advertiser.companyName,
    },
  }));
}

export async function listActiveCampaigns(
  creatorId: string,
): Promise<ActiveCampaignSummary[]> {
  const applications = await prisma.campaignApplication.findMany({
    where: { creatorId, status: "ACCEPTED" },
    orderBy: { updatedAt: "desc" },
    include: {
      campaign: {
        select: {
          id: true,
          title: true,
          platform: true,
          status: true,
          startDate: true,
          endDate: true,
          contentRequirements: true,
          currency: true,
          advertiser: { select: { companyName: true } },
        },
      },
    },
  });

  return applications.map((application) => ({
    applicationId: application.id,
    agreedQuote: application.quoteAmount,
    currency: application.currency,
    campaign: {
      id: application.campaign.id,
      title: application.campaign.title,
      platform: application.campaign.platform,
      status: application.campaign.status,
      startDate: application.campaign.startDate,
      endDate: application.campaign.endDate,
      contentRequirements: application.campaign.contentRequirements,
      currency: application.campaign.currency,
    },
    advertiser: {
      companyName: application.campaign.advertiser.companyName,
    },
  }));
}

type ApplyFailure = { success: false; error: string };

/**
 * Create an application after re-checking every rule on the server. The
 * creatorId comes from the session, never the request.
 */
export async function applyToCampaign(
  creatorId: string,
  input: {
    campaignId: string;
    quoteAmount: string;
    currency: string;
    message?: string;
  },
): Promise<ActionResult<{ applicationId: string }> | ApplyFailure> {
  // Rule: verified email (Stage 10). Read from the DB, never the session.
  const creator = await prisma.creatorProfile.findUnique({
    where: { id: creatorId },
    select: {
      id: true,
      user: { select: { emailVerifiedAt: true } },
    },
  });

  if (!creator) {
    return { success: false, error: "Creator profile not found." };
  }

  if (!creator.user.emailVerifiedAt) {
    return {
      success: false,
      error:
        "Verify your email address before applying to campaigns. You can request a new link from your profile page.",
    };
  }

  const campaign = await prisma.campaign.findUnique({
    where: { id: input.campaignId },
    select: {
      id: true,
      status: true,
      applicationDeadline: true,
      currency: true,
      platform: true,
      advertiser: {
        select: { user: { select: { id: true, role: true } } },
      },
    },
  });

  if (!campaign) {
    return { success: false, error: "This campaign no longer exists." };
  }

  // Rule: creators see published campaigns only; drafts are invisible.
  if (campaign.status !== "PUBLISHED") {
    return {
      success: false,
      error: "This campaign isn't accepting applications right now.",
    };
  }

  // Rule: deadline.
  if (
    campaign.applicationDeadline &&
    campaign.applicationDeadline.getTime() < Date.now()
  ) {
    return {
      success: false,
      error: "Applications for this campaign have closed.",
    };
  }

  // Rule: cannot apply to your own advertiser campaign. The (campaignId,
  // creatorId) unique constraint already prevents a cross-role hit in
  // practice, but the check gives a clear message instead of a generic one.
  if (
    campaign.advertiser.user.id ===
    (await prisma.creatorProfile.findUnique({
      where: { id: creatorId },
      select: { userId: true },
    }))?.userId
  ) {
    return {
      success: false,
      error: "You can't apply to your own campaign.",
    };
  }

  // Rule: currency must match the campaign — no cross-currency quotes.
  if (input.currency !== campaign.currency) {
    return {
      success: false,
      error: `This campaign is priced in ${campaign.currency}. Quote in ${campaign.currency}.`,
    };
  }

  // Rule: a connected (OAuth-proven) account on the campaign's platform.
  // Claims without connection are not enough to enter the marketplace.
  const connectedAccount = await prisma.socialAccount.findFirst({
    where: {
      creatorId,
      platform: campaign.platform,
      platformUserId: { not: null },
    },
    select: { id: true },
  });

  if (!connectedAccount) {
    return {
      success: false,
      error: `Connect your ${campaign.platform} account before applying to this campaign.`,
    };
  }

  // Rule: one active application per campaign — re-application is allowed
  // only after a withdrawal. Enforced by the DB unique constraint; the
  // pre-check just yields a friendlier message for the common path.
  const existing = await prisma.campaignApplication.findUnique({
    where: { campaignId_creatorId: { campaignId: campaign.id, creatorId } },
    select: { id: true, status: true },
  });

  if (
    existing &&
    !REAPPLICABLE_STATUSES.includes(
      existing.status as (typeof REAPPLICABLE_STATUSES)[number],
    )
  ) {
    return {
      success: false,
      error:
        existing.status === "WITHDRAWN"
          ? "You can re-apply to this campaign."
          : "You've already applied to this campaign.",
    };
  }

  try {
    const application = await prisma.campaignApplication.create({
      data: {
        campaignId: campaign.id,
        creatorId,
        message: input.message ?? null,
        quoteAmount: toMoneyString(Number(input.quoteAmount)),
        currency: input.currency,
        status: "PENDING",
      },
      select: { id: true },
    });

    return { success: true, data: { applicationId: application.id } };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return {
        success: false,
        error: "You've already applied to this campaign.",
      };
    }

    console.error("applyToCampaign failed", error);
    return { success: false, error: "Could not submit your application." };
  }
}

/**
 * Withdraw a pending application. The `creatorId` filter is part of the update
 * itself, so ownership is enforced even if the id is guessed.
 */
export async function withdrawApplication(
  creatorId: string,
  applicationId: string,
): Promise<ActionResult> {
  const application = await prisma.campaignApplication.findFirst({
    where: { id: applicationId, creatorId },
    select: { id: true, status: true },
  });

  if (!application) {
    return { success: false, error: "Application not found." };
  }

  if (application.status === "WITHDRAWN") {
    return { success: true, data: undefined };
  }

  if (application.status !== "PENDING") {
    return {
      success: false,
      error: "Only pending applications can be withdrawn.",
    };
  }

  const result = await prisma.campaignApplication.updateMany({
    where: { id: applicationId, creatorId, status: "PENDING" },
    data: { status: "WITHDRAWN" },
  });

  if (result.count === 0) {
    return { success: false, error: "This application can no longer be withdrawn." };
  }

  return { success: true, data: undefined };
}

/** Count of distinct applications in the given statuses (used for filters). */
export async function countCreatorApplications(
  creatorId: string,
  statuses: Prisma.EnumApplicationStatusFilter["in"],
): Promise<number> {
  return prisma.campaignApplication.count({
    where: { creatorId, status: { in: statuses } },
  });
}
