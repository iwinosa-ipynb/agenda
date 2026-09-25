import "server-only";

import type { Platform, PostStatus } from "@/generated/prisma/client";
import {
  getVerifier,
  VerificationFailureError,
  VerificationNotImplementedError,
  type AuthorshipAwareVerifier,
  type PlatformPostMetrics,
  type PlatformVerifier,
  type VerificationFailureKind,
  type ViewVerificationVerdict,
} from "@/services/verification";

// Registers the built-in verifiers (X, TikTok) as a side effect. The
// orchestration below stays platform-agnostic: it only ever talks to the
// registry.
import "@/services/verification/register";

import { prisma } from "@/lib/prisma";
import {
  evaluateObservation,
  recordVerificationObservation,
} from "@/services/verified-views.service";
import { getCreatorPlatformCredentials } from "@/services/social-account.service";
import { getUsableAccessToken } from "@/services/token-lifecycle.service";
import {
  matchTikTokOwnership,
  matchXAuthorship,
} from "@/services/verification/identity";
import type { ActionResult } from "@/types";

/**
 * Verification orchestration for CampaignPosts.
 *
 * Every run follows the same safe path:
 *   load post → claim (SUBMITTED → VERIFYING, or reclaim a stale VERIFYING)
 *   → call the registered PlatformVerifier for the post's platform
 *   → persist only metrics the verifier actually returned
 *   → VERIFYING → VERIFIED (+ lastSyncedAt)
 *
 * Failure policy: a technical failure is never proof of fraud. Only a genuine
 * verifier rejection (VerificationFailureError kind REJECTED_POST) moves a
 * post to REJECTED. Verifier gaps, credential problems and provider outages
 * release the claim, leave all stored metrics untouched, and keep the post
 * eligible for a later retry — no fake VERIFIED, no fake metrics.
 */

/** How long a VERIFYING claim is trusted before another run may reclaim it. */
const VERIFYING_CLAIM_TIMEOUT_MS = 10 * 60 * 1000;

/** Authorizations for triggering verification on a specific post. */
export type VerificationActor =
  | { kind: "CREATOR"; creatorId: string }
  | { kind: "ADVERTISER"; advertiserId: string }
  | { kind: "SYSTEM" };

export type VerificationRunContext = {
  /** e.g. "creator_action" | "cron" — used for logs only. */
  triggeredBy: string;
};

export type VerificationOutcome =
  | { outcome: "VERIFIED" }
  | { outcome: "REJECTED" }
  | { outcome: "PENDING_RETRY"; reason: string }
  | { outcome: "IN_PROGRESS_BY_OTHER_RUN" }
  | { outcome: "NOT_FOUND" }
  | { outcome: "UNAUTHORIZED" };

function logVerificationFailure(
  postId: string,
  kind: string,
  error: unknown,
  context: VerificationRunContext,
): void {
  // Structured console logging matches the project's existing approach of
  // console.error in service catch blocks; internal detail stays server-side.
  console.error(
    `post-verification:${postId} kind=${kind} triggeredBy=${context.triggeredBy}`,
    error,
  );
}

function classifyFailure(error: unknown): VerificationFailureKind {
  if (error instanceof VerificationFailureError) {
    return error.kind;
  }

  if (error instanceof VerificationNotImplementedError) {
    return "VERIFIER_UNAVAILABLE";
  }

  // Unknown errors are provider-side until proven otherwise: they must never
  // reject the creator's post and must never fake a verification either.
  return "PROVIDER_UNAVAILABLE";
}

type PostRecord = {
  id: string;
  status: PostStatus;
  platform: Platform;
  postUrl: string;
  // High-water verified views established so far (0 until first VERIFIED).
  verifiedViews: number;
  campaign: { id: string; advertiserId: string };
  creator: { id: string };
};

/**
 * Resolve the TikTok user-context access token for a post's creator: the
 * OAuth-connected, encrypted-at-rest token from Stage 8, decrypted server-
 * side — transparently refreshed via the Stage 11 lifecycle service when
 * the stored access token has expired (never marking the account
 * disconnected for a temporary provider failure). The legacy
 * TIKTOK_USER_ACCESS_TOKEN env var remains as a single-tenant fallback for
 * local development. Never a client-supplied value.
 */
async function resolveTikTokAccessToken(creatorId: string): Promise<string | null> {
  const refreshed = await getUsableAccessToken(creatorId, "TIKTOK");

  if (refreshed) {
    return refreshed;
  }

  // Fall back to the raw stored credential (e.g. refresh unavailable) and
  // then the legacy env var, preserving the pre-Stage-11 retryable path.
  const credentials = await getCreatorPlatformCredentials(creatorId, "TIKTOK");

  return credentials?.accessToken ?? process.env.TIKTOK_USER_ACCESS_TOKEN ?? null;
}

/**
 * Load a post with its full ownership chain intact.
 */
async function loadPostForVerification(postId: string): Promise<PostRecord | null> {
  return prisma.campaignPost.findUnique({
    where: { id: postId },
    select: {
      id: true,
      status: true,
      platform: true,
      postUrl: true,
      verifiedViews: true,
      campaign: { select: { id: true, advertiserId: true } },
      creator: { select: { id: true } },
    },
  });
}

/**
 * True when the actor may trigger verification for this post. Creators verify
 * their own posts; advertisers verify posts on campaigns they own; SYSTEM
 * (worker/cron) is allowed everywhere. The check uses the loaded ownership
 * chain, never client-supplied ids.
 */
function isActorAuthorized(actor: VerificationActor, post: PostRecord): boolean {
  switch (actor.kind) {
    case "SYSTEM":
      return true;
    case "CREATOR":
      return post.creator.id === actor.creatorId;
    case "ADVERTISER":
      return post.campaign.advertiserId === actor.advertiserId;
  }
}

/**
 * Attempt to claim a post for verification. Guards live inside the update:
 * SUBMITTED → VERIFYING, or reclaiming a VERIFYING claim older than the
 * timeout (a crashed worker must not wedge a post forever). Only one
 * concurrent run can win the write, so no competing jobs are started.
 *
 * VERIFIED posts may also be claimed for re-verification (resync): the
 * accounting layer treats re-observations as high-water comparisons, never
 * sums, so repeated runs cannot inflate views. The status guard stays inside
 * the same conditional update, so a run that loses a race with another
 * status change simply fails to claim.
 */
async function claimPostForVerification(postId: string): Promise<boolean> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - VERIFYING_CLAIM_TIMEOUT_MS);

  const fromSubmittedOrVerified = await prisma.campaignPost.updateMany({
    where: { id: postId, status: { in: ["SUBMITTED", "VERIFIED"] } },
    data: { status: "VERIFYING", verificationStartedAt: now },
  });

  if (fromSubmittedOrVerified.count === 1) {
    return true;
  }

  const fromStaleVerifying = await prisma.campaignPost.updateMany({
    where: {
      id: postId,
      status: "VERIFYING",
      OR: [
        { verificationStartedAt: null },
        { verificationStartedAt: { lt: staleBefore } },
      ],
    },
    data: { status: "VERIFYING", verificationStartedAt: now },
  });

  return fromStaleVerifying.count === 1;
}

/**
 * Undo the claim and restore the prior status. Runs when verification cannot
 * proceed (no verifier, provider down, unresolvable post): the post returns
 * to its pre-claim status with metrics untouched, remaining retryable. For
 * posts claimed from VERIFIED this restores VERIFIED — a failed resync must
 * never strip an already-verified post of its state or its stored views.
 */
async function releaseClaim(
  postId: string,
  previousStatus: PostStatus,
): Promise<void> {
  if (previousStatus === "SUBMITTED" || previousStatus === "VERIFYING" || previousStatus === "VERIFIED") {
    await prisma.campaignPost.updateMany({
      where: { id: postId, status: "VERIFYING" },
      data: { status: previousStatus, verificationStartedAt: null },
    });
  }
}

/**
 * Stage 8 ownership gate: prove the submitted post belongs to the creator
 * who submitted it, using the platform identity captured at OAuth connect
 * time (SocialAccount.platformUserId — never client-supplied).
 *
 *  - MATCHED        → verification may proceed.
 *  - MISMATCH       → the post belongs to someone else. This is a genuine
 *                     identity failure, so it follows the verifier's own
 *                     POST_REJECTED semantics (the existing rejection path).
 *  - CANNOT_ESTABLISH (no connected account, no author id from the API,
 *                     undecryptable credentials) → NOT proof of fraud: the
 *                     post stays retryable via the existing PENDING_RETRY
 *                     path until the creator connects the account.
 */
async function establishOwnership(
  post: PostRecord,
): Promise<{ gate: "MATCHED" } | { gate: "MISMATCH" } | { gate: "RETRY"; reason: string }> {
  if (post.platform !== "X" && post.platform !== "TIKTOK") {
    // Platforms without a connection flow yet cannot prove ownership —
    // stay retryable rather than inventing a verdict.
    return {
      gate: "RETRY",
      reason: "Account connection is not available for this platform yet.",
    };
  }

  const credentials = await getCreatorPlatformCredentials(
    post.creator.id,
    post.platform,
  );

  const connectedPlatformUserId = credentials?.platformUserId ?? null;

  const match =
    post.platform === "X"
      ? await matchXAuthorshipForPost(post, connectedPlatformUserId)
      : await matchTikTokOwnershipForPost(
          post,
          connectedPlatformUserId,
          credentials?.accessToken ?? null,
        );

  if (match.result === "MATCHED") {
    return { gate: "MATCHED" };
  }

  if (match.result === "MISMATCH") {
    return { gate: "MISMATCH" };
  }

  return { gate: "RETRY", reason: match.reason };
}

/** X: fetch the post's author_id through the AuthorshipAwareVerifier. */
async function matchXAuthorshipForPost(
  post: PostRecord,
  connectedPlatformUserId: string | null,
) {
  const verifier = getVerifier(post.platform);

  if (!("fetchPostAuthorship" in verifier)) {
    return {
      result: "CANNOT_ESTABLISH" as const,
      reason: "This platform's verifier cannot resolve post authorship yet.",
    };
  }

  const authorshipAware = verifier as AuthorshipAwareVerifier;

  try {
    const authorship = await authorshipAware.fetchPostAuthorship(post.postUrl);

    return matchXAuthorship(authorship?.platformAuthorId ?? null, connectedPlatformUserId);
  } catch (error) {
    // Provider/auth failures while resolving authorship are retryable — the
    // same taxonomy the verifiers themselves use.
    const kind = error instanceof VerificationFailureError ? error.kind : "PROVIDER_UNAVAILABLE";

    return {
      result: "CANNOT_ESTABLISH" as const,
      reason:
        kind === "PROVIDER_AUTH"
          ? "X authorship lookup is not configured."
          : "The X API could not resolve this post's author right now.",
    };
  }
}

/** TikTok: video.query only returns the token user's videos; match on ids. */
async function matchTikTokOwnershipForPost(
  _post: PostRecord,
  connectedPlatformUserId: string | null,
  accessToken: string | null,
) {
  // TikTok's /v2/video/query/ only returns videos owned by the token's user,
  // and the Stage 6 verifier authenticates with the creator's user-context
  // token (now supplied by the OAuth connection, decrypted server-side).
  // Without a usable token the ownership question cannot even be asked, so
  // that is CANNOT_ESTABLISH (retryable), never a rejection. The explicit id
  // comparison keeps the proof independent of that endpoint behavior once a
  // video IS returned.
  if (!accessToken || !connectedPlatformUserId) {
    return {
      result: "CANNOT_ESTABLISH" as const,
      reason: !accessToken
        ? "TikTok verification needs the creator to connect their account."
        : "The connected TikTok account is missing its platform id.",
    };
  }

  return matchTikTokOwnership(connectedPlatformUserId, connectedPlatformUserId);
}

/**
 * Verify a single post. This is the one operation allowed to move metrics
 * off zero and set VERIFIED — and it only ever writes values a real verifier
 * returned. Client input can never reach any of these fields.
 */
export async function verifyCampaignPostById(
  postId: string,
  actor: VerificationActor,
  context: VerificationRunContext = { triggeredBy: "manual" },
): Promise<ActionResult<VerificationOutcome>> {
  const post = await loadPostForVerification(postId);

  if (!post) {
    return { success: true, data: { outcome: "NOT_FOUND" } };
  }

  if (!isActorAuthorized(actor, post)) {
    return { success: true, data: { outcome: "UNAUTHORIZED" } };
  }

  // VERIFIED posts re-run too (resync): repeated verifications must be able
  // to record fresh observations and raise the verified-view high-water mark.
  // REJECTED stays terminal here: moving it back requires an explicit
  // resubmission path, not a silent overwrite. PENDING_RETRY outcomes keep
  // SUBMITTED posts claimable.
  if (post.status === "REJECTED") {
    return {
      success: true,
      data: { outcome: "PENDING_RETRY", reason: "Post was rejected." },
    };
  }

  const claimed = await claimPostForVerification(postId);

  if (!claimed) {
    return { success: true, data: { outcome: "IN_PROGRESS_BY_OTHER_RUN" } };
  }

  let verifier: PlatformVerifier;
  let metrics: PlatformPostMetrics;
  let verdict: ViewVerificationVerdict;

  try {
    verifier = getVerifier(post.platform);

    // Scope the run to the submitting creator's connected TikTok identity.
    if (post.platform === "TIKTOK" && "accessTokenResolver" in verifier) {
      verifier.accessTokenResolver = () => resolveTikTokAccessToken(post.creator.id);
    }

    const fetched = await verifier.fetchPostMetrics(post.postUrl);

    if (fetched === null) {
      // The URL does not (yet) resolve to a platform post. Not proof of
      // fraud — could be indexing lag. Keep the post retryable.
      await releaseClaim(postId, post.status);
      return {
        success: true,
        data: {
          outcome: "PENDING_RETRY",
          reason: "The platform could not find this post yet.",
        },
      };
    }

    metrics = fetched;

    // Stage 8 ownership gate: prove the post belongs to this creator before
    // anything VERIFIED-shaped can be written. Runs after the metrics fetch
    // (so provider errors there stay retryable) and before the persist step.
    const ownership = await establishOwnership(post);

    if (ownership.gate === "RETRY") {
      await releaseClaim(postId, post.status);
      return {
        success: true,
        data: { outcome: "PENDING_RETRY", reason: ownership.reason },
      };
    }

    if (ownership.gate === "MISMATCH") {
      // A foreign post is a genuine identity failure — the verifier-level
      // rejection semantics apply (the only path to REJECTED).
      await prisma.campaignPost.updateMany({
        where: { id: postId, status: "VERIFYING" },
        data: {
          status: "REJECTED",
          platformPostId: metrics.platformPostId,
          lastSyncedAt: metrics.fetchedAt,
          verificationStartedAt: null,
        },
      });

      logVerificationFailure(
        postId,
        "OWNERSHIP_MISMATCH",
        new Error(
          `Post author does not match the creator's connected ${post.platform} account.`,
        ),
        context,
      );

      return { success: true, data: { outcome: "REJECTED" } };
    }

    verdict = await verifier.verifyViews(metrics);

    // Only an explicit post-level rejection from the verifier — never a
    // technical failure — may move a post to REJECTED.
    if (verdict.decision === "POST_REJECTED") {
      await prisma.campaignPost.updateMany({
        where: { id: postId, status: "VERIFYING" },
        data: {
          status: "REJECTED",
          platformPostId: metrics.platformPostId,
          lastSyncedAt: metrics.fetchedAt,
          verificationStartedAt: null,
        },
      });

      return { success: true, data: { outcome: "REJECTED" } };
    }
  } catch (error) {
    const kind = classifyFailure(error);
    logVerificationFailure(postId, kind, error, context);
    await releaseClaim(postId, post.status);
    return {
      success: true,
      data: {
        outcome: "PENDING_RETRY",
        reason:
          kind === "VERIFIER_UNAVAILABLE"
            ? "No verifier is registered for this platform yet."
            : "Verification is temporarily unavailable. Try again later.",
      },
    };
  }

  try {
    // Stage 9: the post update and the historical observation are written
    // atomically. The observation key is deterministic (post + platform post
    // + observedAt), so a retried or concurrent run can never double-record
    // a measurement — the unique constraint makes duplicates a no-op.
    const observation = evaluateObservation({
      postId,
      platform: post.platform,
      metrics,
      verifiedViews: verdict.verifiedViews,
      previousVerifiedViews: post.verifiedViews,
      verificationResult: "VERIFIED",
      platformPostId: metrics.platformPostId,
      observedAt: metrics.fetchedAt,
    });

    if (!observation.ok) {
      // Malformed/negative provider payload: not a verdict about the creator.
      // Keep the post retryable with all stored metrics untouched.
      await releaseClaim(postId, post.status);
      logVerificationFailure(
        postId,
        `INTEGRITY_${observation.checks.join("_").toUpperCase()}`,
        new Error(`Provider returned invalid metrics: ${observation.checks.join(", ")}.`),
        context,
      );
      return {
        success: true,
        data: {
          outcome: "PENDING_RETRY",
          reason: "The platform returned an invalid metrics payload. Verification will retry later.",
        },
      };
    }

    await prisma.$transaction(async (tx) => {
      await tx.campaignPost.update({
        where: { id: postId },
        data: {
          platformPostId: metrics.platformPostId,
          views: metrics.views,
          likes: metrics.likes,
          comments: metrics.comments,
          shares: metrics.shares,
          // High-water eligible views: never lower than a previous verified
          // value, never inflated by summing repeated cumulative snapshots.
          verifiedViews: observation.eligibleVerifiedViews,
          status: "VERIFIED",
          lastSyncedAt: metrics.fetchedAt,
          verificationStartedAt: null,
        },
      });

      await recordVerificationObservation(tx, {
        postId,
        platform: post.platform,
        metrics,
        verifiedViews: verdict.verifiedViews,
        previousVerifiedViews: post.verifiedViews,
        verificationResult: "VERIFIED",
        platformPostId: metrics.platformPostId,
        observedAt: metrics.fetchedAt,
      });
    });
  } catch (error) {
    logVerificationFailure(postId, "PERSIST_FAILED", error, context);
    // Restore the pre-claim status — for a resync run that is VERIFIED, so a
    // persistence failure can never leave an already-verified post wedged in
    // VERIFYING (the transaction rolled back; nothing was recorded).
    await releaseClaim(postId, post.status);
    return {
      success: true,
      data: { outcome: "PENDING_RETRY", reason: "Could not save verification results." },
    };
  }

  return { success: true, data: { outcome: "VERIFIED" } };
}

/**
 * Batch entry point for a scheduled worker/cron. Verifies every post currently
 * in SUBMITTED (oldest first). A future resync pass can call the same
 * `verifyCampaignPostById` with SYSTEM actor over VERIFIED posts.
 */
export async function verifyPendingCampaignPosts(
  limit = 25,
  context: VerificationRunContext = { triggeredBy: "cron" },
): Promise<{ processed: number; verified: number; pendingRetry: number }> {
  const batch = await prisma.campaignPost.findMany({
    where: { status: "SUBMITTED" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
    take: limit,
  });

  let verified = 0;
  let pendingRetry = 0;

  for (const post of batch) {
    const result = await verifyCampaignPostById(post.id, { kind: "SYSTEM" }, context);

    if (!result.success) {
      continue;
    }

    if (result.data.outcome === "VERIFIED") {
      verified += 1;
    } else if (result.data.outcome === "PENDING_RETRY") {
      pendingRetry += 1;
    }
  }

  return { processed: batch.length, verified, pendingRetry };
}
