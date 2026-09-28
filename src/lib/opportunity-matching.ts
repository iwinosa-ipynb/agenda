import type { Category, Platform } from "@/generated/prisma/client";

/**
 * Creator Opportunity Matching (V1) — pure relevance rules.
 *
 * What matching IS on Agenda:
 *   - a RELEVANCE system. A match means "this published campaign shares
 *     attributes with this creator" — it is deliberately BROADER than
 *     eligibility, and it never implies the creator can or cannot apply.
 *     `applyToCampaign` remains the single authoritative application gate;
 *     matching NEVER applies anyone and never blocks anyone.
 *
 * What matching is NOT:
 *   - not an eligibility check. Follower counts, connected accounts, verified
 *     email and every other `applyToCampaign` rule stay out of these rules on
 *     purpose: audience size below a campaign's minimum is a WEAKER signal
 *     (downgrade), never a rejection. A creator can receive an opportunity
 *     they are not currently eligible to act on.
 *   - not pricing. Agenda is fixed-rate: campaign budget appears only as a
 *     neutral size signal in the reasons, never as a rate and never as a
 *     gate. CPM / per-1,000-views concepts do not exist here.
 *
 * Location is an AND-compatible signal: a campaign targeting a location the
 * creator has not claimed is still delivered (creators relocate, claim
 * loosely, or travel), it just ranks as a weaker signal — the audit rule is
 * "broader than eligibility", so unknown location must not suppress a match.
 *
 * Kept pure (no "server-only", no Prisma) so the rules are directly
 * unit-testable, mirroring src/lib/pricing-math.ts conventions.
 */

/** Creator attributes considered by the relevance rules (all optional). */
export type CreatorMatchProfile = {
  /** Self-reported creator category (the taxonomy campaigns also use). */
  category: Category | null;
  location: string | null;
  state: string | null;
  country: string | null;
  /**
   * Self-reported audience size. A relevance signal only — NEVER an
   * eligibility rule (the campaign minimum weakens the signal, never blocks).
   */
  followerCount: number;
  /** Platforms the creator has any account row for (claimed or connected). */
  platforms: Platform[];
};

/** Campaign attributes considered by the relevance rules. */
export type CampaignMatchProfile = {
  platform: Platform;
  category: Category;
  targetLocation: string;
  /** Campaign open gate for creators' audience size — relevance only. */
  minimumFollowers: number;
};

/** Why this campaign is relevant to this creator (stable snake_case codes). */
export type OpportunityReason =
  | "platform_match"
  | "category_match"
  | "location_match"
  | "audience_size";

export type MatchResult = {
  matched: boolean;
  reasons: OpportunityReason[];
};

/** Case-insensitive contains on free-text location fields (null-safe). */
function locationOverlaps(
  creatorText: string | null,
  campaignText: string,
): boolean {
  if (!creatorText) {
    return false;
  }

  const creator = creatorText.trim().toLowerCase();
  const campaign = campaignText.trim().toLowerCase();

  if (creator === "" || campaign === "") {
    return false;
  }

  return creator.includes(campaign) || campaign.includes(creator);
}

/**
 * Pure relevance classification for one creator/campaign pair.
 *
 * A campaign matches when the creator has an account on the campaign's
 * platform. Category and location then add (or omit) as relevance reasons —
 * their absence weakens the signal but never suppresses the match, which is
 * what makes matching strictly broader than eligibility.
 */
export function classifyOpportunityMatch(
  creator: CreatorMatchProfile,
  campaign: CampaignMatchProfile,
): MatchResult {
  const reasons: OpportunityReason[] = [];

  // Anchor rule: the creator participates on the campaign's platform at all.
  // Without it the campaign is not actionable even in the broadest sense.
  if (!creator.platforms.includes(campaign.platform)) {
    return { matched: false, reasons: [] };
  }

  reasons.push("platform_match");

  if (creator.category !== null && creator.category === campaign.category) {
    reasons.push("category_match");
  }

  if (
    locationOverlaps(creator.location, campaign.targetLocation) ||
    locationOverlaps(creator.state, campaign.targetLocation) ||
    locationOverlaps(creator.country, campaign.targetLocation)
  ) {
    reasons.push("location_match");
  }

  // Audience size: the campaign's own minimum, used ONLY as a signal
  // strength. Never a pass/fail — eligibility stays with applyToCampaign.
  if (creator.followerCount >= campaign.minimumFollowers) {
    reasons.push("audience_size");
  }

  return { matched: true, reasons };
}
