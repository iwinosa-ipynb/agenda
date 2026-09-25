import "server-only";

import type { Prisma } from "@/generated/prisma/client";

import { prisma } from "@/lib/prisma";
import {
  verifyCampaignPostById,
  type VerificationActor,
  type VerificationRunContext,
} from "@/services/post-verification.service";
import {
  openMilestoneReviewAfterVerification,
  completeMilestoneReverification,
} from "@/services/payments/milestone-review.service";
import { parseCampaignPost } from "@/validation/post";
import type { CampaignPostInput } from "@/validation/post";

/**
 * Stage 13C — creator milestone submissions (the deterministic
 * post→milestone association point).
 *
 * A verified post is NEVER assigned to a milestone by guesswork. The
 * association is created HERE, explicitly, when the creator submits a post
 * against a specific milestone after passing every server-side eligibility
 * check (identity, agreement ownership, milestone state, funding gate,
 * platform match, duplicate protection). Stage 9 then verifies that exact
 * post and the result attaches to that exact MilestoneSubmission.
 *
 * ONE POST → ONE MILESTONE SUBMISSION: the postId unique constraint on
 * MilestoneSubmission makes double-assignment impossible at the database
 * level — a post that already fulfills one milestone can never be submitted
 * for another (and corrections reuse the existing rows, never re-point them).
 *
 * Stage 9 is NOT duplicated: verification runs through
 * verifyCampaignPostById (ownership, platform checks, metrics, integrity,
 * verified-view accounting all live there).
 */

export type MilestoneSubmissionErrorCode =
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "INVALID_STATE"
  | "FUNDING_MISSING"
  | "PLATFORM_MISMATCH"
  | "DUPLICATE_POST"
  | "POST_ALREADY_ASSOCIATED"
  | "MISSING_TERMS"
  | "VALIDATION_FAILED"
  | "CONCURRENT_CONFLICT";

export type MilestoneSubmissionResult =
  | {
      ok: true;
      submissionId: string;
      milestoneId: string;
      postId: string;
      sequence: number;
      /** Stage 9 outcome for this submission. */
      verification: "VERIFIED" | "REJECTED" | "RETRYABLE";
      /** Milestone state after the verification outcome was applied. */
      milestoneStatus: string;
      /** True when advertiser review opened (all required posts verified). */
      reviewOpened: boolean;
      /** Human-readable, state-appropriate message for the creator UI. */
      message: string;
    }
  | { ok: false; code: MilestoneSubmissionErrorCode; reason: string };

/** States from which a NEW (non-correction) submission is acceptable. */
const SUBMISSIBLE_STATES: ReadonlySet<string> = new Set(["PENDING"]);

/** States that accept ONLY the correction workflow (never fresh posts). */
const CORRECTION_ONLY_STATES: ReadonlySet<string> = new Set([
  "CORRECTION_REQUESTED",
  "PENDING_REVERIFICATION",
]);

/** Terminal / permanently closed states — no submissions, ever. */
const CLOSED_STATES: ReadonlySet<string> = new Set([
  "RELEASED",
  "VALID_CANCELLATION",
  "CONFIRMED_RELEASE",
  "SETTLEMENT_PENDING",
]);

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

/**
 * Submit a published post as fulfillment of a specific milestone.
 *
 * Eligibility (ALL server-side — the UI determines nothing):
 *   1. Authenticated creator is the agreement's creator (identity from
 *      session via requireViewerCreatorId in the calling action — never from
 *      a client field).
 *   2. The milestone belongs to that agreement.
 *   3. Milestone state accepts this kind of submission (PENDING for fresh
 *      posts; CORRECTION_REQUESTED only via submitMilestoneCorrection;
 *      RELEASED/VALID_CANCELLATION/CONFIRMED/SETTLEMENT never).
 *   4. FUNDING GATE: the agreement's Stage 13A obligation holds
 *      provider-verified escrow. "I paid" / client status / browser
 *      references count for nothing.
 *   5. The creator has a connected platform account.
 *   6. Post platform matches the agreement's frozen platform.
 *   7. Duplicate protection: the exact post URL must be new for this
 *      creator+campaign, AND the post must not already be associated with
 *      any other milestone submission (one post → one milestone submission).
 *   8. Required milestone terms (amount frozen at plan time) exist.
 *
 * On success, Stage 9 verification runs for the created post and the outcome
 * is attached to this submission:
 *   VERIFIED   → submission stamped, milestone review opens when all required
 *                posts are verified (via the existing 13B entry point)
 *   REJECTED   → submission stamped, milestone stays PENDING, no review
 *   RETRYABLE  → submission stays pending; Stage 9's own retry semantics hold
 */
export async function submitMilestonePost(
  milestoneId: string,
  actor: { creatorProfileId: string; userId: string },
  input: CampaignPostInput,
): Promise<MilestoneSubmissionResult> {
  // ---- Load the milestone with its full ownership chain (all in-query). ----
  const milestone = await prisma.milestone.findFirst({
    where: {
      id: milestoneId,
      creatorId: actor.creatorProfileId,
    },
    select: {
      id: true,
      agreementId: true,
      campaignId: true,
      advertiserId: true,
      creatorId: true,
      status: true,
      requiredPostCount: true,
      creatorAmountMinor: true,
      currency: true,
    },
  });

  if (!milestone) {
    return {
      ok: false,
      code: "NOT_FOUND",
      reason: "Milestone not found — it may belong to another creator or agreement.",
    };
  }

  // ---- Agreement ownership + frozen platform. ----
  const agreement = await prisma.campaignAgreement.findUnique({
    where: { id: milestone.agreementId },
    select: {
      id: true,
      status: true,
      creatorId: true,
      platform: true,
      agreedAmount: true,
    },
  });

  if (!agreement || agreement.creatorId !== actor.creatorProfileId) {
    return {
      ok: false,
      code: "UNAUTHORIZED",
      reason: "This agreement does not belong to you.",
    };
  }

  // ---- Milestone state gates (13C §10). ----
  if (CLOSED_STATES.has(milestone.status)) {
    return {
      ok: false,
      code: "INVALID_STATE",
      reason: "This milestone is already settled or cancelled and cannot accept submissions.",
    };
  }

  if (CORRECTION_ONLY_STATES.has(milestone.status)) {
    return {
      ok: false,
      code: "INVALID_STATE",
      reason:
        "This milestone is in the correction workflow — submit the corrected post through the correction flow, not as a new submission.",
    };
  }

  if (!SUBMISSIBLE_STATES.has(milestone.status)) {
    return {
      ok: false,
      code: "INVALID_STATE",
      reason: "This milestone is not currently accepting submissions.",
    };
  }

  // ---- FUNDING GATE (13C §5): only server-side financial state counts. ----
  const obligation = await prisma.financialObligation.findUnique({
    where: { agreementId: milestone.agreementId },
    select: { escrowFunded: true, status: true, dispute: true },
  });

  if (!obligation || !obligation.escrowFunded) {
    return {
      ok: false,
      code: "FUNDING_MISSING",
      reason:
        "This agreement's funding is not confirmed yet, so you cannot submit work against it.",
    };
  }

  if (obligation.dispute) {
    return {
      ok: false,
      code: "FUNDING_MISSING",
      reason: "The agreement's funds are under review; submissions are paused.",
    };
  }

  // ---- Required milestone terms available (frozen at plan time). ----
  if (milestone.creatorAmountMinor <= 0n) {
    return {
      ok: false,
      code: "MISSING_TERMS",
      reason: "This milestone's frozen terms are incomplete — contact support.",
    };
  }

  // ---- Connected platform account must exist. ----
  const connection = await prisma.socialAccount.findFirst({
    where: {
      creatorId: actor.creatorProfileId,
      platform: agreement.platform,
    },
    select: { id: true },
  });

  if (!connection) {
    return {
      ok: false,
      code: "PLATFORM_MISMATCH",
      reason: "Connect your platform account before submitting work.",
    };
  }

  // ---- Platform must match the agreement's frozen platform. ----
  if (input.platform !== agreement.platform) {
    return {
      ok: false,
      code: "PLATFORM_MISMATCH",
      reason: `This milestone's deliverables are for ${agreement.platform} — submit a post from that platform.`,
    };
  }

  // ---- Duplicate protection: same URL for the same creator+campaign. ----
  const duplicateUrl = await prisma.campaignPost.findFirst({
    where: {
      campaignId: milestone.campaignId,
      creatorId: actor.creatorProfileId,
      postUrl: input.postUrl,
    },
    select: { id: true },
  });

  if (duplicateUrl) {
    return {
      ok: false,
      code: "DUPLICATE_POST",
      reason: "You've already submitted this post URL for this campaign.",
    };
  }

  const now = new Date();

  // ---- Create the post + the explicit submission association atomically. ----
  let postId: string;
  let sequence: number;
  let submissionId: string;

  try {
    const created = await prisma.$transaction(async (tx) => {
      // Metrics/status are zeroed server-side; nothing comes from the client
      // except platform + URL + descriptive text (validated by the schema).
      const post = await tx.campaignPost.create({
        data: {
          campaignId: milestone.campaignId,
          creatorId: actor.creatorProfileId,
          platform: input.platform,
          postUrl: input.postUrl,
          caption: input.caption ?? null,
          creatorNote: input.creatorNote ?? null,
          views: 0,
          likes: 0,
          comments: 0,
          shares: 0,
          verifiedViews: 0,
          status: "SUBMITTED",
        },
        select: { id: true },
      });

      const lastSubmission = await tx.milestoneSubmission.findFirst({
        where: { milestoneId },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });

      const nextSequence = (lastSubmission?.sequence ?? 0) + 1;

      // ONE POST → ONE MILESTONE SUBMISSION: the postId unique constraint
      // makes double-assignment to another milestone impossible. A losing
      // concurrent race rolls back the whole transaction (post included).
      const submission = await tx.milestoneSubmission.create({
        data: {
          milestoneId,
          agreementId: milestone.agreementId,
          sequence: nextSequence,
          postId: post.id,
          submittedById: actor.userId,
          verificationStatus: "SUBMITTED",
        },
        select: { id: true },
      });

      await tx.milestoneEvent.create({
        data: {
          milestoneId,
          agreementId: milestone.agreementId,
          eventType: "milestone_submission_created",
          actor: "CREATOR",
          actorId: actor.userId,
          source: "milestone-submission",
          details: {
            postId: post.id,
            submissionId: submission.id,
            sequence: nextSequence,
            platform: input.platform,
          },
          idempotencyKey: `mevt:${milestoneId}:submission_created:${post.id}`,
        },
      });

      return { postId: post.id, sequence: nextSequence, submissionId: submission.id };
    });

    postId = created.postId;
    sequence = created.sequence;
    submissionId = created.submissionId;
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The post is already bound to a milestone submission — never move it.
      return {
        ok: false,
        code: "POST_ALREADY_ASSOCIATED",
        reason: "This post is already fulfilling a milestone.",
      };
    }

    console.error("submitMilestonePost failed", error);

    return {
      ok: false,
      code: "CONCURRENT_CONFLICT",
      reason: "Could not record the submission. Please try again.",
    };
  }

  // ---- Stage 9 verification for THIS exact post (not duplicated). ----
  const verificationActor: VerificationActor = {
    kind: "CREATOR",
    creatorId: actor.creatorProfileId,
  };

  const runContext: VerificationRunContext = { triggeredBy: "milestone_submission" };

  const verification = await verifyCampaignPostById(postId, verificationActor, runContext);

  if (!verification.success) {
    // Unexpected infrastructure failure: the submission exists and stays
    // retryable via the normal Stage 9 paths. Never a fake verdict.
    return {
      ok: true,
      submissionId,
      milestoneId,
      postId,
      sequence,
      verification: "RETRYABLE",
      milestoneStatus: "PENDING",
      reviewOpened: false,
      message: "Submission recorded — verification will retry.",
    };
  }

  const outcome = verification.data.outcome;

  if (outcome === "VERIFIED") {
    // Attach the result to this submission and open review through the
    // EXISTING 13B entry point (no duplicated transition logic).
    const opened = await openMilestoneReviewAfterVerification(milestoneId, postId);

    if (opened.ok) {
      const isMultiPost = (milestone.requiredPostCount ?? 1) > 1;
      const reviewOpened = opened.reviewOpened === true;

      return {
        ok: true,
        submissionId,
        milestoneId,
        postId,
        sequence,
        verification: "VERIFIED",
        milestoneStatus: reviewOpened ? "VERIFIED_PENDING_REVIEW" : "PENDING",
        reviewOpened,
        message: reviewOpened
          ? "All deliverables verified — your advertiser can now review."
          : isMultiPost
            ? "Post verified. The milestone needs more verified posts before advertiser review opens."
            : "Post verified — awaiting the review window.",
      };
    }

    // A verified post that could not open review (e.g. missing association
    // after a concurrent change) is surfaced honestly: verification held,
    // review not opened, no money moves.
    return {
      ok: true,
      submissionId,
      milestoneId,
      postId,
      sequence,
      verification: "VERIFIED",
      milestoneStatus: "PENDING",
      reviewOpened: false,
      message: "Post verified, but the milestone review could not open yet.",
    };
  }

  if (outcome === "REJECTED") {
    // Genuine verifier rejection (e.g. ownership mismatch): stamp the
    // submission, keep the milestone PENDING, never open review.
    await prisma.milestoneSubmission.updateMany({
      where: { id: submissionId, verificationStatus: { not: "VERIFIED" } },
      data: { verificationStatus: "REJECTED" },
    });

    await prisma.milestoneEvent.create({
      data: {
        milestoneId,
        agreementId: milestone.agreementId,
        eventType: "milestone_submission_rejected",
        actor: "SYSTEM",
        actorId: null,
        source: "milestone-submission",
        details: { postId, submissionId, sequence },
        idempotencyKey: `mevt:${milestoneId}:submission_rejected:${postId}`,
      },
    }).catch(() => undefined);

    return {
      ok: true,
      submissionId,
      milestoneId,
      postId,
      sequence,
      verification: "REJECTED",
      milestoneStatus: "PENDING",
      reviewOpened: false,
      message:
        "The post did not pass verification (e.g. it does not appear to belong to your connected account). Submit a replacement post.",
    };
  }

  // PENDING_RETRY / IN_PROGRESS_BY_OTHER_RUN / NOT_FOUND / UNAUTHORIZED —
  // Stage 9's retryable semantics hold: nothing is rejected, nothing opens.
  const retryOutcome = outcome as unknown as
    | { outcome: "PENDING_RETRY"; reason: string }
    | { outcome: string };
  const retryReason =
    retryOutcome.outcome === "PENDING_RETRY" && "reason" in retryOutcome
      ? retryOutcome.reason
      : "Verification is pending.";

  await prisma.milestoneEvent.create({
    data: {
      milestoneId,
      agreementId: milestone.agreementId,
      eventType: "milestone_submission_retryable",
      actor: "SYSTEM",
      actorId: null,
      source: "milestone-submission",
      details: {
        postId,
        submissionId,
        sequence,
        outcome: retryOutcome,
        reason: retryReason,
      },
      idempotencyKey: `mevt:${milestoneId}:submission_retryable:${postId}`,
    },
  }).catch(() => undefined);

  return {
    ok: true,
    submissionId,
    milestoneId,
    postId,
    sequence,
    verification: "RETRYABLE",
    milestoneStatus: "PENDING",
    reviewOpened: false,
    message: `Verification will retry: ${retryReason}`,
  };
}

/**
 * Re-run Stage 9 verification for a milestone's latest pending submission and
 * apply the outcome (used by sweeps/workers). Keeps the same deterministic
 * association — no new submission row is created for a retry.
 */
export async function verifyLatestMilestoneSubmission(
  milestoneId: string,
): Promise<MilestoneSubmissionResult | { ok: false; code: "NOT_FOUND"; reason: string }> {
  const milestone = await prisma.milestone.findUnique({
    where: { id: milestoneId },
    select: {
      id: true,
      agreementId: true,
      status: true,
      requiredPostCount: true,
      creatorId: true,
    },
  });

  if (!milestone) {
    return { ok: false, code: "NOT_FOUND", reason: "Milestone not found." };
  }

  const submission = await prisma.milestoneSubmission.findFirst({
    where: { milestoneId, verificationStatus: { in: ["SUBMITTED", "VERIFYING"] } },
    orderBy: { sequence: "desc" },
    select: { id: true, postId: true, sequence: true },
  });

  if (!submission) {
    return { ok: false, code: "NOT_FOUND", reason: "No pending submission to verify." };
  }

  const verification = await verifyCampaignPostById(
    submission.postId,
    { kind: "SYSTEM" },
    { triggeredBy: "milestone_submission_retry" },
  );

  if (!verification.success) {
    return {
      ok: true,
      submissionId: submission.id,
      milestoneId,
      postId: submission.postId,
      sequence: submission.sequence,
      verification: "RETRYABLE",
      milestoneStatus: milestone.status,
      reviewOpened: false,
      message: "Verification will retry.",
    };
  }

  const outcome = verification.data.outcome;

  if (outcome === "VERIFIED") {
    if (milestone.status === "PENDING_REVERIFICATION") {
      const completed = await completeMilestoneReverification(milestoneId);

      return {
        ok: true,
        submissionId: submission.id,
        milestoneId,
        postId: submission.postId,
        sequence: submission.sequence,
        verification: "VERIFIED",
        milestoneStatus: completed.ok ? String(completed.status) : milestone.status,
        reviewOpened: completed.ok && completed.status === "VERIFIED_PENDING_REVIEW",
        message: "Corrected post verified.",
      };
    }

    const opened = await openMilestoneReviewAfterVerification(milestoneId, submission.postId);

    return {
      ok: true,
      submissionId: submission.id,
      milestoneId,
      postId: submission.postId,
      sequence: submission.sequence,
      verification: "VERIFIED",
      milestoneStatus: opened.ok ? String(opened.status) : milestone.status,
      reviewOpened: opened.ok && opened.reviewOpened === true,
      message: "Post verified.",
    };
  }

  if (outcome === "REJECTED") {
    await prisma.milestoneSubmission.updateMany({
      where: { id: submission.id, verificationStatus: { not: "VERIFIED" } },
      data: { verificationStatus: "REJECTED" },
    });

    return {
      ok: true,
      submissionId: submission.id,
      milestoneId,
      postId: submission.postId,
      sequence: submission.sequence,
      verification: "REJECTED",
      milestoneStatus: milestone.status,
      reviewOpened: false,
      message: "The post did not pass verification. Submit a replacement post.",
    };
  }

  return {
    ok: true,
    submissionId: submission.id,
    milestoneId,
    postId: submission.postId,
    sequence: submission.sequence,
    verification: "RETRYABLE",
    milestoneStatus: milestone.status,
    reviewOpened: false,
    message: "Verification is still pending or will retry.",
  };
}

// Re-export the correction submission so the UI/action layer has ONE import
// site for all creator submission flows.
export {
  submitMilestoneCorrection,
} from "@/services/payments/milestone-review.service";
