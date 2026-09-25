import "server-only";

import type { Category, Platform } from "@/generated/prisma/client";

import { prisma } from "@/lib/prisma";
import {
  buildGuidanceRange,
  type DataAvailability,
  type GuidanceRange,
} from "@/lib/pricing-math";
import type { PricingDataAvailability } from "@/generated/prisma/client";

/**
 * Stage 12 — marketplace pricing guidance.
 *
 * Design rules (per the Stage 12 brief):
 *   - Creator-controlled pricing + Agenda guidance. Agenda never sets or
 *     overrides a creator's quote, and never overrides an advertiser's budget.
 *   - Every recommendation is computed from real accepted-agreement history in
 *     the database (platform + category matched). When there is not enough
 *     history, the result is an explicit INSUFFICIENT_DATA state with no
 *     numbers. Nothing is ever fabricated or hard-coded.
 *
 * The DB contract: amounts live in `agreedAmount` (Decimal, stringified by
 * the caller via .toString()) alongside `currency`. Only completed real
 * agreements count — drafts, pending and rejected applications contribute
 * nothing.
 */

export type PricingGuidance = {
  dataAvailability: PricingDataAvailability;
  /** Inclusive suggested quote range; null when data is insufficient. */
  suggestedMin: string | null;
  suggestedMax: string | null;
  /** Number of real historical agreements the range is based on. */
  sampleSize: number;
  /** Human-facing basis of the recommendation or the insufficiency. */
  explanation: string;
};

function toEnumAvailability(
  availability: DataAvailability,
): PricingDataAvailability {
  return availability === "AVAILABLE"
    ? "AVAILABLE"
    : "INSUFFICIENT_DATA";
}

/**
 * Quote guidance for a creator applying to a specific campaign. History is
 * filtered to the campaign's platform + category and the campaign's currency,
 * so a fashion/TikTok range is never shown for a tech/X campaign.
 */
export async function getCampaignQuoteGuidance(
  campaignId: string,
): Promise<PricingGuidance> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: {
      platform: true,
      category: true,
      currency: true,
      budget: true,
    },
  });

  if (!campaign) {
    return {
      dataAvailability: "INSUFFICIENT_DATA",
      suggestedMin: null,
      suggestedMax: null,
      sampleSize: 0,
      explanation: "This campaign doesn't exist, so no guidance is available.",
    };
  }

  // A campaign that already has agreements carries the most relevant history:
  // what this exact advertiser actually paid for this exact campaign shape.
  const sameCampaign = await prisma.campaignAgreement.findMany({
    where: {
      campaignId,
      currency: campaign.currency,
    },
    select: { agreedAmount: true },
  });

  const comparable = await prisma.campaignAgreement.findMany({
    where: {
      status: "ACTIVE",
      currency: campaign.currency,
      campaign: {
        platform: campaign.platform satisfies Platform,
        category: campaign.category satisfies Category,
        id: { not: campaignId },
      },
    },
    select: { agreedAmount: true },
    take: 200,
  });

  const samples = [...sameCampaign, ...comparable].map((row) =>
    Number(row.agreedAmount.toString()),
  );

  const range: GuidanceRange = buildGuidanceRange(samples);

  if (range.dataAvailability === "INSUFFICIENT_DATA") {
    return {
      dataAvailability: "INSUFFICIENT_DATA",
      suggestedMin: null,
      suggestedMax: null,
      sampleSize: range.sampleSize,
      explanation:
        "Not enough marketplace data yet to provide a reliable suggested range. Price what your work is worth — the advertiser sees your quote before accepting.",
    };
  }

  return {
    dataAvailability: "AVAILABLE",
    suggestedMin: range.suggestedMin,
    suggestedMax: range.suggestedMax,
    sampleSize: range.sampleSize,
    explanation: `Based on ${range.sampleSize} comparable ${
      range.sampleSize === 1 ? "agreement" : "agreements"
    } on ${campaign.platform} campaigns in this category.`,
  };
}

/**
 * Budget guidance for an advertiser creating/publishing a campaign. Uses the
 * same real-history rule as quote guidance; the advertiser can always proceed
 * with their own budget regardless of the answer.
 *
 * Scope: when platform/category are supplied the range covers comparable
 * campaigns; when they are omitted (e.g. the blank create form) the range is
 * marketplace-wide and the explanation says so explicitly.
 */
export async function getCampaignBudgetGuidance(input: {
  platform?: Platform;
  category?: Category;
  currency: string;
  /** The advertiser's current budget, when they've entered one. */
  budget?: string | null;
}): Promise<PricingGuidance> {
  const comparable = await prisma.campaignAgreement.findMany({
    where: {
      status: "ACTIVE",
      currency: input.currency,
      campaign: {
        ...(input.platform ? { platform: input.platform } : {}),
        ...(input.category ? { category: input.category } : {}),
      },
    },
    select: { agreedAmount: true },
    take: 200,
  });

  const range = buildGuidanceRange(
    comparable.map((row) => Number(row.agreedAmount.toString())),
  );

  if (range.dataAvailability === "INSUFFICIENT_DATA") {
    return {
      dataAvailability: "INSUFFICIENT_DATA",
      suggestedMin: null,
      suggestedMax: null,
      sampleSize: range.sampleSize,
      explanation:
        "We don't yet have enough marketplace data to provide a reliable budget recommendation.",
    };
  }

  const min = range.suggestedMin ? Number(range.suggestedMin) : null;
  const max = range.suggestedMax ? Number(range.suggestedMax) : null;
  const budget = input.budget ? Number(input.budget) : null;

  const scope =
    input.platform && input.category
      ? "comparable campaigns in this category"
      : "campaigns across the marketplace";

  let explanation =
    `Recommended campaign budget is between ${min?.toLocaleString()} and ${max?.toLocaleString()} ${input.currency}, ` +
    `based on ${range.sampleSize} ${
      range.sampleSize === 1 ? "agreement" : "agreements"
    } for ${scope}.`;

  if (budget !== null && max !== null && budget < min!) {
    explanation +=
      " Your budget is below the recommended range — this may limit the number of creators who apply.";
  }

  return {
    dataAvailability: "AVAILABLE",
    suggestedMin: range.suggestedMin,
    suggestedMax: range.suggestedMax,
    sampleSize: range.sampleSize,
    explanation,
  };
}
