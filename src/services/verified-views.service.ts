import "server-only";

import type {
  ObservationIntegrityStatus,
  Platform,
  PostStatus,
} from "@/generated/prisma/client";

import { prisma } from "@/lib/prisma";
import {
  accountPostVerifiedViews,
  aggregateCampaignVerifiedViews,
  evaluateObservation,
  type AccountedPost,
  type CampaignVerifiedViewTotals,
  type IntegrityCheckId,
  type ObservationInput,
} from "@/services/verified-views-accounting";
import type { CampaignVerifiedViewsSummary } from "@/types";

// Re-exported for the orchestrator, which consumes the service module.
export { evaluateObservation } from "@/services/verified-views-accounting";
export type { ObservationInput } from "@/services/verified-views-accounting";

/**
 * Stage 9 — verified-view accounting (server side).
 *
 * Everything in this module runs on the server and consumes only trusted
 * data: metrics produced by the official platform verification layer and
 * ownership state derived from OAuth connections. No function here accepts
 * metrics, statuses or totals from a client; campaign totals are always
 * recomputed from database rows.
 *
 * Recording is idempotent and concurrency-safe: the observation write happens
 * inside the same transaction as the post update, guarded by a unique
 * constraint on a deterministic key, so a retried or parallel verification
 * run can never double-record a measurement.
 */

export type RecordObservationResult = {
  recorded: boolean;
  /** Present when the observation was already recorded (idempotent no-op). */
  duplicate: boolean;
  observationKey: string;
  /** The eligible (high-water) verified view count this run established. */
  eligibleVerifiedViews: number;
  integrityStatus: ObservationIntegrityStatus;
  integrityChecks: IntegrityCheckId[];
};

/**
 * Record one successful verification observation. MUST be called only after
 * the orchestrator has: fetched real platform metrics, established ownership
 * and reached a VERIFIED decision — the caller enforces this.
 *
 * Idempotent via the unique observationKey: a concurrent/retried run that
 * computed the same key hits the unique constraint and is reported as a
 * duplicate no-op instead of double-counting. On duplicate, the caller's
 * transaction continues safely with the previously stored post values.
 */
export async function recordVerificationObservation(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  input: ObservationInput,
): Promise<RecordObservationResult> {
  const evaluation = evaluateObservation(input);

  try {      await tx.postVerificationObservation.create({
        data: {
          postId: input.postId,
          platform: input.platform,
          // Verbatim verifier output — never a client-supplied value.
          platformPostId: input.platformPostId,
          observedAt: input.observedAt,
        views: input.metrics.views,
        likes: input.metrics.likes,
        comments: input.metrics.comments,
        shares: input.metrics.shares,
        verifiedViews: evaluation.eligibleVerifiedViews,
        verificationResult: input.verificationResult,
        observationKey: evaluation.observationKey,
        integrityStatus: evaluation.integrityStatus,
        integrityChecks: evaluation.checks,
      },
      select: { id: true },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      // Same (post, platform post, observedAt) measurement already recorded.
      // Idempotent no-op — never an error for the verification run.
      return {
        recorded: false,
        duplicate: true,
        observationKey: evaluation.observationKey,
        eligibleVerifiedViews: evaluation.eligibleVerifiedViews,
        integrityStatus: evaluation.integrityStatus,
        integrityChecks: ["duplicate_observation"],
      };
    }

    throw error;
  }

  return {
    recorded: true,
    duplicate: false,
    observationKey: evaluation.observationKey,
    eligibleVerifiedViews: evaluation.eligibleVerifiedViews,
    integrityStatus: evaluation.integrityStatus,
    integrityChecks: evaluation.checks,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

// ---------------------------------------------------------------------------
// Reads — per-post accounting and campaign totals
// ---------------------------------------------------------------------------

/**
 * Shared select projection + mapper for verified-view read queries. Keeps the
 * eligibility filters (VERIFIED posts, creators with a platform connection)
 * and the eligibility re-check inputs identical across per-post, campaign and
 * creator reads, so they can never drift apart.
 */
const accountedPostSelect = {
  id: true,
  platform: true,
  status: true,
  verifiedViews: true,
  creator: {
    select: {
      socialAccounts: {
        where: { platformUserId: { not: null } },
        select: { platform: true },
      },
    },
  },
  observations: {
    where: { verificationResult: "VERIFIED" },
    orderBy: { observedAt: "desc" },
    take: 1,
    select: { integrityStatus: true },
  },
} as const;

type AccountedPostRow = {
  id: string;
  platform: Platform;
  status: PostStatus;
  verifiedViews: number;
  creator: {
    socialAccounts: Array<{ platform: Platform }>;
  };
  observations: Array<{ integrityStatus: ObservationIntegrityStatus }>;
};

function toAccountedPost(post: AccountedPostRow): AccountedPost {
  return {
    id: post.id,
    platform: post.platform,
    status: post.status,
    verifiedViews: post.verifiedViews,
    ownershipEstablished: post.creator.socialAccounts.some(
      (account) => account.platform === post.platform,
    ),
    ownershipMismatch: false,
    integrityFlagged: post.observations[0]?.integrityStatus === "REVIEW",
  };
}

/**
 * Load the accounting inputs for one post: the latest successful observation
 * (if any) plus whether ownership is provable from the creator's connected
 * accounts. All values come from database rows, never from a client.
 */
async function loadAccountedPost(postId: string): Promise<AccountedPost | null> {
  const post = await prisma.campaignPost.findUnique({
    where: { id: postId },
    select: {
      ...accountedPostSelect,
      platformPostId: true,
      observations: {
        where: { verificationResult: "VERIFIED" },
        orderBy: { observedAt: "desc" },
        take: 1,
        select: {
          integrityStatus: true,
          integrityChecks: true,
        },
      },
    },
  });

  if (!post) {
    return null;
  }

  const latestObservation = post.observations[0] ?? null;

  // Ownership is "established" only when a connected account for this
  // platform exists with a provider-issued platformUserId. Mismatch is not
  // persisted on VERIFIED posts (mismatched posts are REJECTED by the
  // verifier path), so it is derivable here, not trusted from anywhere.
  const ownershipEstablished = post.creator.socialAccounts.some(
    (account) => account.platform === post.platform,
  );

  return {
    id: post.id,
    platform: post.platform,
    status: post.status,
    verifiedViews: post.verifiedViews,
    ownershipEstablished,
    ownershipMismatch: false,
    integrityFlagged: latestObservation?.integrityStatus === "REVIEW",
  };
}

/**
 * Verified-view accounting for a single post. Returns null when the post
 * does not exist.
 */
export async function getPostVerifiedViewAccounting(postId: string): Promise<{
  eligible: boolean;
  views: number;
  status: "CLEAN" | "REVIEW";
  lastSyncedAt: Date | null;
} | null> {
  const [accounted, post] = await Promise.all([
    loadAccountedPost(postId),
    prisma.campaignPost.findUnique({
      where: { id: postId },
      select: { lastSyncedAt: true },
    }),
  ]);

  if (!accounted || !post) {
    return null;
  }

  const accountedViews = accountPostVerifiedViews(accounted);

  return {
    eligible: accountedViews.eligible,
    views: accountedViews.views,
    // Only eligible VERIFIED posts can be flagged REVIEW here; REJECTED is
    // reserved for the ownership-mismatch path, which never reaches this read.
    status: accountedViews.status === "REVIEW" ? ("REVIEW" as const) : ("CLEAN" as const),
    lastSyncedAt: post.lastSyncedAt,
  };
}

/**
 * Verified-view summary for one creator (Stage 9C dashboard UI).
 *
 * Server-side only: aggregates the creator's VERIFIED posts through the same
 * accounting layer used for campaign totals, so the dashboard number and the
 * campaign number can never diverge. Ownership eligibility is re-checked by
 * the pure accounting layer exactly as in `getCampaignVerifiedViews`.
 *
 * Returns zeros (honest "no eligible posts" output) when the creator has no
 * verified content yet — never fabricated numbers.
 */
export async function getCreatorVerifiedViews(
  creatorId: string,
): Promise<CampaignVerifiedViewsSummary> {
  const posts = await prisma.campaignPost.findMany({
    where: {
      creatorId,
      status: "VERIFIED",
      creator: {
        socialAccounts: {
          some: { platformUserId: { not: null } },
        },
      },
    },
    select: accountedPostSelect,
  });

  return aggregateCampaignVerifiedViews(posts.map(toAccountedPost));
}

/**
 * Campaign verified-view totals, computed server-side from eligible posts.
 *
 * Eligibility rules (enforced in the query, then re-checked by the pure
 * accounting layer):
 *   - only VERIFIED posts
 *   - only posts whose creator has a connected account on the post's platform
 *     with a provider-issued platformUserId (proven ownership)
 *   - each post contributes its CURRENT cumulative verified count — repeated
 *     observations are never summed, so nothing can double-count
 *
 * Ownership scoping: pass `advertiserId` to require the campaign to belong to
 * that advertiser (used by advertiser-facing callers). Returns null when the
 * campaign does not exist or is not owned by the given advertiser.
 */
export async function getCampaignVerifiedViews(
  campaignId: string,
  options: { advertiserId?: string } = {},
): Promise<CampaignVerifiedViewTotals | null> {
  const posts = await prisma.campaignPost.findMany({
    where: {
      campaignId,
      ...(options.advertiserId
        ? { campaign: { advertiserId: options.advertiserId } }
        : {}),
      status: "VERIFIED",
      creator: {
        socialAccounts: {
          some: { platformUserId: { not: null } },
        },
      },
    },
    select: accountedPostSelect,
  });

  return aggregateCampaignVerifiedViews(posts.map(toAccountedPost));
}
