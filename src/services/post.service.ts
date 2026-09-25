import "server-only";

import type { CampaignStatus, Platform, PostStatus } from "@/generated/prisma/client";

import { prisma } from "@/lib/prisma";
import { decideSubmission } from "@/services/submission-rules";
import type {
  ActionResult,
  AdvertiserPostSummary,
} from "@/types";
import type { CampaignPostInput } from "@/validation/post";

/**
 * Creator content submissions. A post is created only through an accepted
 * application, and every metric stays zero until a real platform verifier
 * exists — nothing here fabricates views, verified views or payouts.
 */

const postSummarySelect = {
  id: true,
  platform: true,
  postUrl: true,
  caption: true,
  creatorNote: true,
  status: true,
  views: true,
  likes: true,
  comments: true,
  shares: true,
  verifiedViews: true,
  lastSyncedAt: true,
  createdAt: true,
} as const;

/**
 * Resolve the submission context for a creator and campaign. The application
 * lookup uses the (campaignId, creatorId) unique constraint, so a creator can
 * only ever reach their own accepted participation — not another creator's.
 */
export async function getCreatorCampaignSubmissionContext(
  creatorId: string,
  campaignId: string,
): Promise<{
  campaign: {
    id: string;
    title: string;
    platform: Platform;
    contentRequirements: string | null;
    rules: string | null;
    startDate: Date | null;
    endDate: Date | null;
    status: CampaignStatus;
  };
  advertiser: { companyName: string };
  posts: Array<{
    id: string;
    postUrl: string;
    status: PostStatus;
    createdAt: Date;
  }>;
} | null> {
  const application = await prisma.campaignApplication.findUnique({
    where: { campaignId_creatorId: { campaignId, creatorId } },
    select: { status: true },
  });

  // An accepted application is the only key to this workflow. Pending,
  // rejected, withdrawn or non-existent participation all render as not found
  // so nothing about the campaign leaks to an outsider.
  if (!application || application.status !== "ACCEPTED") {
    return null;
  }

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      title: true,
      platform: true,
      contentRequirements: true,
      rules: true,
      startDate: true,
      endDate: true,
      status: true,
      advertiser: { select: { companyName: true } },
    },
  });

  if (!campaign) {
    return null;
  }

  const posts = await prisma.campaignPost.findMany({
    where: { campaignId, creatorId },
    orderBy: { createdAt: "desc" },
    select: { id: true, postUrl: true, status: true, createdAt: true },
  });

  return {
    campaign: {
      id: campaign.id,
      title: campaign.title,
      platform: campaign.platform,
      contentRequirements: campaign.contentRequirements,
      rules: campaign.rules,
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      status: campaign.status,
    },
    advertiser: { companyName: campaign.advertiser.companyName },
    posts,
  };
}

export async function getCreatorCampaignPost(
  creatorId: string,
  campaignId: string,
  postId: string,
) {
  return prisma.campaignPost.findFirst({
    where: { id: postId, campaignId, creatorId },
    select: postSummarySelect,
  });
}

/** Every post the creator has submitted, for the /dashboard/posts history. */
export async function listCreatorCampaignPosts(creatorId: string): Promise<
  Array<{
    id: string;
    platform: Platform;
    postUrl: string;
    status: PostStatus;
    views: number;
    likes: number;
    comments: number;
    shares: number;
    verifiedViews: number;
    lastSyncedAt: Date | null;
    createdAt: Date;
    campaign: { id: string; title: string; advertiser: { companyName: string } };
    /**
     * Neutral integrity presentation for the latest verified observation
     * (Stage 9C): CLEAN → normal display; REVIEW → "additional verification
     * required" language. Never exposes internal check ids or accusations.
     */
    integrity: "CLEAN" | "REVIEW";
  }>
> {
  const posts = await prisma.campaignPost.findMany({
    where: { creatorId },
    orderBy: { createdAt: "desc" },
    select: {
      ...postSummarySelect,
      campaign: {
        select: {
          id: true,
          title: true,
          advertiser: { select: { companyName: true } },
        },
      },
      // Latest verified observation drives neutral integrity language in the
      // creator UI (REVIEW → "additional verification required"), mirroring
      // the advertiser post list in this service.
      observations: {
        where: { verificationResult: "VERIFIED" },
        orderBy: { observedAt: "desc" },
        take: 1,
        select: { integrityStatus: true },
      },
    },
  });

  return posts.map((post) => ({
    id: post.id,
    platform: post.platform,
    postUrl: post.postUrl,
    status: post.status,
    views: post.views,
    likes: post.likes,
    comments: post.comments,
    shares: post.shares,
    verifiedViews: post.verifiedViews,
    lastSyncedAt: post.lastSyncedAt,
    createdAt: post.createdAt,
    campaign: post.campaign,
    integrity:
      post.observations[0]?.integrityStatus === "REVIEW" ? "REVIEW" : "CLEAN",
  }));
}

/**
 * Create a post submission. Every rule is re-checked on the server:
 * accepted application, campaign open for content, no duplicate URL. Metrics
 * and status are always initialised here — never read from the request.
 */
export async function submitCampaignPost(
  creatorId: string,
  campaignId: string,
  input: CampaignPostInput,
): Promise<ActionResult<{ postId: string }>> {
  const application = await prisma.campaignApplication.findUnique({
    where: { campaignId_creatorId: { campaignId, creatorId } },
    select: { status: true },
  });

  if (!application || application.status !== "ACCEPTED") {
    return {
      success: false,
      error: "You can only submit content for campaigns you've been accepted into.",
    };
  }

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true, endDate: true },
  });

  if (!campaign) {
    return { success: false, error: "This campaign no longer exists." };
  }  // Submissions belong to a live collaboration: the campaign must not have
  // been cancelled or completed, and must not have already ended.
  if (campaign.status === "CANCELLED" || campaign.status === "COMPLETED") {
    return {
      success: false,
      error: "This campaign has ended, so it no longer accepts submissions.",
    };
  }

  if (campaign.endDate && campaign.endDate.getTime() < Date.now()) {
    return {
      success: false,
      error: "This campaign has ended, so it no longer accepts submissions.",
    };
  }

  // One active submission per campaign. REJECTED posts are the only state
  // that unlocks a replacement submission; VERIFIED is never editable. The
  // decision reads only this creator's own posts (creatorId in the where).
  const existingPosts = await prisma.campaignPost.findMany({
    where: { campaignId, creatorId },
    select: { id: true, status: true },
  });

  const decision = decideSubmission(existingPosts);

  if (decision.kind === "BLOCKED") {
    return { success: false, error: decision.reason };
  }

  // Preserve the existing duplicate-URL protection: a creator cannot bounce
  // the same rejected URL back into the queue to bypass verification.
  const existingUrl = await prisma.campaignPost.findFirst({
    where: { campaignId, creatorId, postUrl: input.postUrl },
    select: { id: true },
  });

  if (existingUrl) {
    return {
      success: false,
      error: "You've already submitted this post URL for this campaign.",
    };
  }

  try {
    // A resubmission creates a FRESH record; the rejected post is never
    // mutated, so the rejection and its verification history stay intact for
    // audits. The new record is explicitly zeroed server-side: metrics,
    // verifiedViews and all verification bookkeeping start clean no matter
    // what any client sent.
    const post = await prisma.campaignPost.create({
      data: {
        campaignId,
        creatorId,
        platform: input.platform,
        postUrl: input.postUrl,
        caption: input.caption ?? null,
        creatorNote: input.creatorNote ?? null,
        // Metrics are zero on submission and only ever move through the
        // verification system — never from a client request.
        views: 0,
        likes: 0,
        comments: 0,
        shares: 0,
        verifiedViews: 0,
        status: "SUBMITTED",
        verificationStartedAt: null,
        lastSyncedAt: null,
        platformPostId: null,
      },
      select: { id: true },
    });

    return { success: true, data: { postId: post.id } };
  } catch (error) {
    console.error("submitCampaignPost failed", error);
    return {
      success: false,
      error: "Could not record your submission. Please try again.",
    };
  }
}

/**
 * Submitted posts for campaigns owned by this advertiser, optionally scoped to
 * a single campaign. The ownership chain (post → campaign → advertiser) is
 * filtered inside the query, so a guessed campaign or post id can never expose
 * another advertiser's content.
 */
export async function listAdvertiserCampaignPosts(
  advertiserId: string,
  campaignId?: string,
): Promise<AdvertiserPostSummary[]> {
  const posts = await prisma.campaignPost.findMany({
    where: {
      campaign: {
        advertiserId,
        ...(campaignId ? { id: campaignId } : {}),
      },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      ...postSummarySelect,
      campaign: { select: { id: true, title: true, status: true } },
      creator: {
        select: {
          username: true,
          user: { select: { name: true } },
        },
      },
      // Latest verified observation drives neutral integrity language in the
      // advertiser UI (REVIEW → "additional verification required").
      observations: {
        where: { verificationResult: "VERIFIED" },
        orderBy: { observedAt: "desc" },
        take: 1,
        select: { integrityStatus: true },
      },
    },
  });

  return posts.map((post) => ({
    id: post.id,
    platform: post.platform,
    postUrl: post.postUrl,
    caption: post.caption,
    status: post.status,
    views: post.views,
    likes: post.likes,
    comments: post.comments,
    shares: post.shares,
    verifiedViews: post.verifiedViews,
    lastSyncedAt: post.lastSyncedAt,
    createdAt: post.createdAt,
    campaign: {
      id: post.campaign.id,
      title: post.campaign.title,
      status: post.campaign.status,
    },
    creator: {
      name: post.creator.user.name,
      username: post.creator.username,
    },
    integrity:
      post.observations[0]?.integrityStatus === "REVIEW" ? "REVIEW" : "CLEAN",
  }));
}
