import "server-only";

import { prisma } from "@/lib/prisma";
import {
  classifyOpportunityMatch,
  type OpportunityReason,
} from "@/lib/opportunity-matching";

/**
 * Creator Opportunity Matching + Notifications (V1) — server-side service.
 *
 * Trigger: ONLY the campaign publication flow (server actions calling this
 * after a successful DRAFT → PUBLISHED / publish-on-create). There is no
 * client path into this module: no form field, creator id, or campaign id
 * from a request can create an opportunity — the campaign id comes from the
 * server's own write result.
 *
 * Visibility discipline: matching mirrors the marketplace's own open-listing
 * rules (PUBLISHED + deadline still open, the same predicate
 * `listCampaigns` shows to creators), so a creator is never notified about a
 * campaign they could not legally see. Private terms (frozen agreements,
 * other creators' quotes, support data) are never included — the reason
 * strings name only the creator's own profile attributes against public
 * campaign attributes.
 *
 * Dedupe: one row per (campaign, creator) enforced by the DB unique
 * constraint; racing/re-running publications land on the constraint and are
 * skipped. In-app delivery is the system of record; email is best-effort
 * (failures are logged and never break publication).
 *
 * Matching is RELEVANCE, not eligibility: `applyToCampaign` stays the single
 * authoritative gate, this module never applies anyone and never blocks
 * anyone, and creators may receive opportunities they are not currently
 * eligible to act on (see src/lib/opportunity-matching.ts).
 */

const REASON_LABELS: Record<OpportunityReason, string> = {
  platform_match: "You have an account on the campaign's platform",
  category_match: "It matches your category",
  location_match: "It targets a location on your profile",
  audience_size: "Your audience size meets the campaign's preference",
};

/** Marketplace open-listing visibility predicate (mirrors listCampaigns). */
function openListingWhere(now: Date) {
  return {
    status: "PUBLISHED" as const,
    OR: [
      { applicationDeadline: null },
      { applicationDeadline: { gte: now } },
    ],
  };
}

/**
 * Match ONE campaign (expected freshly published) against all creators and
 * create the opportunity rows. Skips silently when the campaign is not
 * publicly visible (defensive: publication callers pass a just-published id,
 * but the guard keeps the module honest if reused later, e.g. from a cron).
 *
 * Never throws to the caller: publication must not fail because matching
 * did. Errors are logged once and reported as `matched: false`.
 */
export async function notifyMatchingCreatorsForCampaign(
  campaignId: string,
): Promise<{ matched: number; skipped: boolean }> {
  try {
    return await notifyMatchingCreatorsForCampaigns([campaignId]);
  } catch (error) {
    console.error("notifyMatchingCreatorsForCampaign failed", error);
    return { matched: 0, skipped: true };
  }
}

/**
 * Batch variant over one query — used by the publication trigger so a
 * multi-campaign flow stays a constant number of round trips.
 */
export async function notifyMatchingCreatorsForCampaigns(
  campaignIds: string[],
): Promise<{ matched: number; skipped: boolean }> {
  if (campaignIds.length === 0) {
    return { matched: 0, skipped: false };
  }

  try {
    const now = new Date();

    // The campaigns must satisfy the marketplace's open-listing visibility —
    // the same rules a creator browsing /dashboard/campaigns is subject to.
    const campaigns = await prisma.campaign.findMany({
      where: { id: { in: campaignIds }, ...openListingWhere(now) },
      select: {
        id: true,
        platform: true,
        category: true,
        targetLocation: true,
        minimumFollowers: true,
      },
    });

    if (campaigns.length === 0) {
      return { matched: 0, skipped: true };
    }

    // All creator profiles with the attributes the relevance rules use. The
    // platform set comes from ANY account row (claimed or connected) —
    // matching is broader than eligibility, so a claimed account still
    // signals "creator participates on this platform".
    const creators = await prisma.creatorProfile.findMany({
      select: {
        id: true,
        category: true,
        location: true,
        state: true,
        country: true,
        followerCount: true,
        socialAccounts: { select: { platform: true } },
      },
    });

    const platformByCreator = new Map<string, string[]>();

    for (const creator of creators) {
      platformByCreator.set(
        creator.id,
        creator.socialAccounts.map((account) => account.platform),
      );
    }

    const rows: Array<{
      campaignId: string;
      creatorId: string;
      reasons: string[];
    }> = [];

    for (const campaign of campaigns) {
      for (const creator of creators) {
        const result = classifyOpportunityMatch(
          {
            category: creator.category,
            location: creator.location,
            state: creator.state,
            country: creator.country,
            followerCount: creator.followerCount,
            platforms: (platformByCreator.get(creator.id) ??
              []) as never as Array<
              Parameters<typeof classifyOpportunityMatch>[0]["platforms"][number]
            >,
          },
          {
            platform: campaign.platform,
            category: campaign.category,
            targetLocation: campaign.targetLocation,
            minimumFollowers: campaign.minimumFollowers,
          },
        );

        if (result.matched) {
          rows.push({
            campaignId: campaign.id,
            creatorId: creator.id,
            reasons: result.reasons,
          });
        }
      }
    }

    if (rows.length === 0) {
      return { matched: 0, skipped: false };
    }

    // createMany + the DB unique (campaignId, creatorId) is the dedupe
    // arbiter: re-runs and raced publications skipExisting rows instead of
    // double-notifying. skipDuplicates keeps one racing trigger from failing.
    const created = await prisma.creatorOpportunityNotification.createMany({
      data: rows,
      skipDuplicates: true,
    });

    await deliverOpportunityEmails(campaignIds);

    return { matched: created.count, skipped: false };
  } catch (error) {
    console.error("notifyMatchingCreatorsForCampaigns failed", error);
    return { matched: 0, skipped: true };
  }
}

/**
 * Best-effort email for the freshly created opportunities. In-app is the
 * system of record; email failures are logged and never propagate — the
 * publication flow that triggered matching must never break on email.
 * Unverified addresses are skipped (same discipline as the marketplace's
 * own verification gate; those creators still get the in-app notification).
 */
async function deliverOpportunityEmails(campaignIds: string[]): Promise<void> {
  try {
    const { isEmailConfigured, sendEmail } = await import(
      "@/lib/email/email-service"
    );

    if (!isEmailConfigured()) {
      // In-app notifications remain fully functional without email config.
      return;
    }

    const rows = await prisma.creatorOpportunityNotification.findMany({
      where: {
        campaignId: { in: campaignIds },
        // Email only rows we have not already emailed-ish: there is no
        // email-state column by design (V1 keeps the table minimal), so the
        // caller emails only right after creating rows — the dedupe window.
        readAt: null,
      },
      select: {
        id: true,
        campaignId: true,
        reasons: true,
        campaign: {
          select: { title: true, platform: true, applicationDeadline: true },
        },
        creator: {
          select: {
            user: { select: { email: true, emailVerifiedAt: true } },
          },
        },
      },
    });

    // Same env var the OAuth callback routes and verification emails use —
    // deployments configure the base URL once.
    const baseUrl = process.env.APP_BASE_URL?.trim() || "";

    for (const row of rows) {
      const email = row.creator.user.email;
      const verified = row.creator.user.emailVerifiedAt !== null;

      if (!email || !verified || baseUrl === "") {
        continue;
      }

      const reasonLines = row.reasons
        .map(
          (reason) =>
            REASON_LABELS[reason as OpportunityReason] ?? reason,
        )
        .map((label) => `- ${label}`)
        .join("\n");

      const campaignUrl = `${baseUrl}/dashboard/campaigns/${row.campaignId}`;

      try {
        await sendEmail({
          to: email,
          subject: `New opportunity: ${row.campaign.title}`,
          text: [
            `A new campaign on Agenda matches your profile:`,
            ``,
            row.campaign.title,
            ``,
            `Why it's relevant:`,
            reasonLines,
            ``,
            `You set your own fixed price if you apply — review it here:`,
            campaignUrl,
          ].join("\n"),
          html: [
            `<p>A new campaign on Agenda matches your profile:</p>`,
            `<p><strong>${escapeHtml(row.campaign.title)}</strong></p>`,
            `<p>Why it's relevant:</p><ul>${row.reasons
              .map(
                (reason) =>
                  `<li>${escapeHtml(
                    REASON_LABELS[reason as OpportunityReason] ?? reason,
                  )}</li>`,
              )
              .join("")}</ul>`,
            `<p>You set your own fixed price if you apply — <a href="${campaignUrl}">review the campaign</a>.</p>`,
          ].join(""),
        });
      } catch (error) {
        // Best-effort per recipient: one bad address never stops the rest.
        console.error(
          "opportunity email send failed for notification",
          row.id,
          error instanceof Error ? error.message : error,
        );
      }
    }
  } catch (error) {
    console.error("opportunity email delivery failed", error);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ---------------------------------------------------------------------------
// Creator-side reads (session-resolved creator id — never client-supplied)
// ---------------------------------------------------------------------------

export type CreatorOpportunitySummary = {
  id: string;
  reasons: string[];
  readAt: Date | null;
  createdAt: Date;
  campaign: {
    id: string;
    title: string;
    platform: string;
    category: string;
    budget: string;
    currency: string;
    applicationDeadline: Date | null;
    advertiserName: string;
  };
};

/**
 * The signed-in creator's opportunities, newest first, with their campaign
 * summary. Only the creator's OWN rows are ever readable — the creatorId is
 * the session-resolved profile id, and ownership rides inside the query.
 */
export async function listCreatorOpportunities(
  creatorId: string,
): Promise<{ opportunities: CreatorOpportunitySummary[]; unread: number }> {
  const rows = await prisma.creatorOpportunityNotification.findMany({
    where: { creatorId },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      campaign: {
        select: {
          id: true,
          title: true,
          platform: true,
          category: true,
          budget: true,
          currency: true,
          applicationDeadline: true,
          advertiser: { select: { companyName: true } },
        },
      },
    },
  });

  return {
    opportunities: rows.map((row) => ({
      id: row.id,
      reasons: row.reasons,
      readAt: row.readAt,
      createdAt: row.createdAt,
      campaign: {
        id: row.campaign.id,
        title: row.campaign.title,
        platform: row.campaign.platform,
        category: row.campaign.category,
        budget: row.campaign.budget.toString(),
        currency: row.campaign.currency,
        applicationDeadline: row.campaign.applicationDeadline,
        advertiserName: row.campaign.advertiser.companyName,
      },
    })),
    unread: rows.filter((row) => row.readAt === null).length,
  };
}

/**
 * Mark one of the creator's own opportunities read. Ownership rides inside
 * the update where-clause: a guessed foreign id matches nothing.
 */
export async function markCreatorOpportunityRead(
  creatorId: string,
  notificationId: string,
): Promise<boolean> {
  const result = await prisma.creatorOpportunityNotification.updateMany({
    where: { id: notificationId, creatorId, readAt: null },
    data: { readAt: new Date() },
  });

  return result.count > 0;
}

/** Unread count for the signed-in creator (nav badge). */
export async function countCreatorUnreadOpportunities(
  creatorId: string,
): Promise<number> {
  return prisma.creatorOpportunityNotification.count({
    where: { creatorId, readAt: null },
  });
}
