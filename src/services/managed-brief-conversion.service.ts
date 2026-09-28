import "server-only";

import type { Prisma } from "@/generated/prisma/client";

import { isManagedBriefSourcingAccountEligible } from "@/lib/managed-brief-eligibility";
import { toMoneyString } from "@/lib/pricing-math";
import { prisma } from "@/lib/prisma";
import type { ManagedBriefConversionInput } from "@/validation/managed-brief";

/**
 * Agenda Managed (V1, slice 5) — convert a SELECTED sourcing candidate into a
 * DRAFT marketplace Campaign, owned by the brief's advertiser.
 *
 * What this deliberately IS:
 *   - the smallest bridge between the managed workflow and the existing
 *     marketplace: it creates ONLY a Campaign row (status DRAFT) and writes
 *     the traceability link onto the candidate;
 *   - ownership-scoped like every other advertiser read/write: the brief is
 *     looked up through the session-resolved advertiser id, so a foreign or
 *     guessed brief/candidate id returns a refusal, never data.
 *
 * What this deliberately is NOT:
 *   - no CampaignApplication (the selected creator still applies themselves
 *     and authors their own fixed quote);
 *   - no CampaignAgreement (that is born only from acceptance of an
 *     application);
 *   - no FinancialObligation / milestone / payment / ledger row (money
 *     objects are born only from funding preparation on an agreement);
 *   - no auto-publish (the DRAFT goes through the existing publication
 *     blockers and lifecycle);
 *   - no new brief/candidate status (SELECTED stays terminal; the nullable
 *     campaignId link IS the conversion traceability);
 *   - the brief's informational budgetMinor is never promoted: the campaign
 *     budget comes from the advertiser's explicit conversion input.
 *
 * Platform mapping: the Campaign's platform comes from the selected
 * candidate's SocialAccount — a real, verified identity anchor, never free
 * text. Nothing else on the brief is coerced into an enum value.
 *
 * Race safety: the candidate's campaignId is UNIQUE at the database level.
 * The service pre-checks and the link write is the arbiter — two concurrent
 * conversions create two Campaign rows, but only ONE link write can succeed;
 * the loser's transaction is rolled back (the orphan campaign is never
 * committed) and the caller receives a clear already-converted refusal.
 */

export type ConversionErrorCode =
  | "BRIEF_NOT_FOUND"
  | "CANDIDATE_NOT_FOUND"
  | "NOT_SELECTED"
  | "INELIGIBLE_ACCOUNT"
  | "ALREADY_CONVERTED"
  | "INVALID_INPUT"
  | "CONVERSION_FAILED";

export type ConversionResult =
  | {
      success: true;
      data: { campaignId: string; candidateId: string; briefId: string };
    }
  | { success: false; code: ConversionErrorCode; error: string };

/**
 * The SELECTED candidate an advertiser can convert, for their OWN brief —
 * the read side of the slice 5 bridge (null when nothing is convertible).
 *
 * Exposure policy (deliberately minimal, mandated by the locked decision
 * that the owning advertiser performs the conversion): the advertiser sees
 * the selected creator's PUBLIC identity only — display name, username,
 * category and the pinned platform account. Internal support data (notes,
 * outreach records, sourcing status history, operator ids) is never
 * selected by this function, exactly as in slices 3–4.
 */
export async function getSelectedCandidateForConversion(
  advertiserId: string,
  briefId: string,
): Promise<{
  candidateId: string;
  creatorName: string;
  creatorUsername: string;
  creatorCategory: string;
  accountPlatform: string;
  accountUsername: string;
  campaignId: string | null;
  /**
   * True when the pinned account can back a conversion (connectable
   * platform + OAuth-connected). False means conversion is REFUSED until
   * the creator connects the account — surfaced so the brief page can show
   * why instead of rendering a form that can only fail.
   */
  accountEligible: boolean;
} | null> {
  // Ownership-in-query: the brief lookup itself carries the advertiser id.
  const brief = await prisma.managedBrief.findFirst({
    where: { id: briefId, advertiserId },
    select: { id: true },
  });

  if (!brief) {
    return null;
  }

  const candidate = await prisma.managedBriefSourcingCandidate.findFirst({
    where: { briefId: brief.id, status: "SELECTED" },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      campaignId: true,
      creator: {
        select: {
          username: true,
          category: true,
          user: { select: { name: true } },
        },
      },
      socialAccount: {
        select: { platform: true, username: true, platformUserId: true },
      },
    },
  });

  if (!candidate) {
    return null;
  }

  return {
    candidateId: candidate.id,
    creatorName: candidate.creator.user.name ?? candidate.creator.username,
    creatorUsername: candidate.creator.username,
    creatorCategory: String(candidate.creator.category),
    accountPlatform: candidate.socialAccount.platform,
    accountUsername: candidate.socialAccount.username,
    campaignId: candidate.campaignId,
    accountEligible: isManagedBriefSourcingAccountEligible(
      candidate.socialAccount,
    ),
  };
}

export async function convertSelectedCandidateToDraftCampaign(
  advertiserId: string,
  input: ManagedBriefConversionInput & {
    startDate: Date | null;
    endDate: Date | null;
    applicationDeadline: Date | null;
  },
): Promise<ConversionResult> {
  // ---- 1. Ownership-in-query: the brief must belong to THIS advertiser. ----
  const brief = await prisma.managedBrief.findFirst({
    where: { id: input.briefId, advertiserId },
    select: {
      id: true,
      campaignGoal: true,
      description: true,
      creatorRequirements: true,
      status: true,
    },
  });

  if (!brief) {
    return {
      success: false,
      code: "BRIEF_NOT_FOUND",
      error: "Brief not found.",
    };
  }

  // ---- 2. The candidate must belong to that brief, be SELECTED, unconverted,
  // and carry its identity anchors (creator + platform account). ----
  const candidate = await prisma.managedBriefSourcingCandidate.findFirst({
    where: { id: input.candidateId, briefId: brief.id },
    select: {
      id: true,
      status: true,
      campaignId: true,
      creatorId: true,
      socialAccount: { select: { platform: true, platformUserId: true } },
    },
  });

  if (!candidate) {
    return {
      success: false,
      code: "CANDIDATE_NOT_FOUND",
      error: "Candidate not found.",
    };
  }

  if (candidate.campaignId) {
    return {
      success: false,
      code: "ALREADY_CONVERTED",
      error: "This candidate has already been converted to a campaign.",
    };
  }

  if (candidate.status !== "SELECTED") {
    return {
      success: false,
      code: "NOT_SELECTED",
      error: "Only a SELECTED candidate can be converted.",
    };
  }

  // ---- 2b. Sourcing eligibility, re-checked against the STORED account at
  // conversion time. The platform inherited by the Campaign comes from this
  // account, and the marketplace application gate (`applyToCampaign`)
  // requires a CONNECTED account on that platform — converting an ineligible
  // candidate would create a campaign the selected creator can never apply
  // to. Defense-in-depth: the picker, the add path and the SELECTED
  // transition already enforce the same rule; this boundary protects against
  // rows pinned before it existed and against accounts DISCONNECTED after
  // selection (disconnect nulls platformUserId). The pinned account is never
  // rewritten or swapped — the refusal tells the advertiser what to do.
  if (!isManagedBriefSourcingAccountEligible(candidate.socialAccount)) {
    return {
      success: false,
      code: "INELIGIBLE_ACCOUNT",
      error:
        "This candidate's account is not connected (TikTok or X). Have the creator connect it before creating the campaign.",
    };
  }

  // ---- 3. Create the DRAFT campaign and link it, atomically. The unique
  // campaignId is the race arbiter: only one conversion of this candidate
  // can ever commit. ----
  try {
    const campaignId = await prisma.$transaction(async (tx) => {
      const campaign = await tx.campaign.create({
        data: {
          advertiserId,
          // The selected account's platform — a real identity anchor, never
          // client free text.
          platform: candidate.socialAccount.platform,
          title: input.title,
          // The brief's own words carry over as the description; the goal is
          // prepended so the marketplace listing stays truthful to the brief.
          description: `${brief.campaignGoal}\n\n${brief.description}`,
          category: input.category,
          targetLocation: input.targetLocation,
          // Explicit advertiser budget — never the brief's informational one.
          budget: toMoneyString(input.budget),
          // Retired CPM column: kept zero for new campaigns (see schema note).
          pricePerThousandViews: toMoneyString(0),
          currency: "NGN",
          minimumFollowers: input.minimumFollowers,
          maxCreators: input.maxCreators,
          startDate: input.startDate,
          endDate: input.endDate,
          applicationDeadline: input.applicationDeadline,
          contentRequirements: input.contentRequirements ?? brief.creatorRequirements ?? null,
          rules: input.rules ?? null,
          tags: [],
          status: "DRAFT",
        },
        select: { id: true },
      });

      // The link write is the concurrency arbiter: a concurrent conversion
      // already claimed the unique campaignId → P2002 here rolls BOTH writes
      // back, so no orphan campaign ever commits.
      await tx.managedBriefSourcingCandidate.update({
        where: { id: candidate.id },
        data: { campaignId: campaign.id },
      });

      return campaign.id;
    });

    return {
      success: true,
      data: { campaignId, candidateId: candidate.id, briefId: brief.id },
    };
  } catch (error) {
    const isUniqueViolation =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2002";

    if (isUniqueViolation) {
      return {
        success: false,
        code: "ALREADY_CONVERTED",
        error: "This candidate has already been converted to a campaign.",
      };
    }

    console.error("convertSelectedCandidateToDraftCampaign failed", error);

    return {
      success: false,
      code: "CONVERSION_FAILED",
      error: "Could not create the campaign. Please try again.",
    };
  }
}
