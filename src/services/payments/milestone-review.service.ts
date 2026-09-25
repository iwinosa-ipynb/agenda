import "server-only";

import type { Prisma } from "@/generated/prisma/client";

import { prisma } from "@/lib/prisma";
import {
  checkMilestoneTransition,
  reviewWindowDeadline,
  pausedSecondsBetween,
  type MilestoneState,
  type MilestoneTransitionCause,
} from "@/services/payments/milestone-state-machine";
import { settleConfirmedMilestone } from "@/services/payments/milestone.service";

/**
 * Stage 13B — milestone review, correction, escalation and release.
 *
 * Every state change here is server-authorized, conditionally updated (the
 * database is the concurrency arbiter) and documented by an immutable,
 * idempotently-keyed MilestoneEvent. There is NO automatic release: the 24h
 * advertiser review window is an audit/display fact only — an expired window
 * never moves a milestone, it can only be recorded as advertiser-caused
 * delay. LOW VIEWS / LIKES / COMMENTS NEVER BLOCK anything: no social metric
 * is consulted anywhere in this module.
 *
 * Authorization contracts:
 *   - Advertiser actions take `{ advertiserProfileId, userId }` resolved from
 *     the server session (never client input) and are checked against the
 *     milestone's denormalized advertiserId.
 *   - Creator actions take `{ creatorProfileId, userId }` likewise.
 *   - Support actions take an explicit authenticated actor contract (Agenda
 *     has no admin role yet — the same seam convention as dispute.service).
 */

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

export type PartyActor =
  | { kind: "ADVERTISER"; advertiserProfileId: string; userId: string }
  | { kind: "CREATOR"; creatorProfileId: string; userId: string };

export type SupportActor = {
  authenticated: boolean;
  userId: string;
  source: string;
};

export type MilestoneErrorCode =
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "INVALID_STATE"
  | "MISSING_POST"
  | "POST_NOT_VERIFIED"
  | "FUNDING_MISSING"
  | "VALIDATION_FAILED"
  | "CONCURRENT_CONFLICT";

export type MilestoneActionResult =
  | {
      ok: true;
      milestoneId: string;
      status: MilestoneState;
      /** True when this call was a no-op replay of an already-applied action. */
      idempotentReplay: boolean;
      /**
       * Stage 13C: false when the milestone's required posts are not all
       * VERIFIED yet — the milestone stays PENDING and advertiser review
       * does NOT open (never open review after 1 of 3 required posts).
       */
      reviewOpened?: boolean;
    }
  | { ok: false; code: MilestoneErrorCode; reason: string };

class MilestoneActionRefusedError extends Error {
  code: MilestoneErrorCode;

  constructor(code: MilestoneErrorCode, message: string) {
    super(message);
    this.name = "MilestoneActionRefusedError";
    this.code = code;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

/** Write one immutable milestone event; duplicate keys are silent no-ops. */
async function recordEvent(
  tx: Prisma.TransactionClient,
  input: {
    milestoneId: string;
    agreementId: string;
    eventType: string;
    actor: string;
    actorId: string | null;
    source: string;
    details: Record<string, unknown>;
    idempotencyKey: string;
  },
): Promise<void> {
  try {
    await tx.milestoneEvent.create({
      data: input as unknown as Prisma.MilestoneEventCreateInput,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    // Duplicate key: the event already exists — idempotent replay.
  }
}

/**
 * Provider-verified funding gate. A milestone can never enter advertiser
 * review or be released unless the agreement's Stage 13A obligation holds
 * provider-verified escrow ("server-side verified funding exists").
 */
async function assertFundingVerified(agreementId: string): Promise<void> {
  const obligation = await prisma.financialObligation.findUnique({
    where: { agreementId },
    select: { escrowFunded: true, dispute: true },
  });

  if (!obligation || !obligation.escrowFunded) {
    throw new MilestoneActionRefusedError(
      "FUNDING_MISSING",
      "This agreement's funding has not been verified yet, so its milestones cannot enter review.",
    );
  }
}

/**
 * Run one guarded milestone transition:
 *   load → pure-table check → conditional update → audit event.
 * Any refusal throws inside the transaction, rolling back ALL writes.
 */
async function runMilestoneTransition(options: {
  milestoneId: string;
  from: MilestoneState;
  to: MilestoneState;
  cause: MilestoneTransitionCause;
  actor: string;
  actorId: string | null;
  source: string;
  eventType: string;
  details: Record<string, unknown>;
  eventKey: string;
  /** Extra row updates merged into the update data. */
  data?: Record<string, unknown>;
}): Promise<MilestoneActionResult> {
  try {
    const status = await prisma.$transaction(async (tx) => {
      const row = await tx.milestone.findUnique({
        where: { id: options.milestoneId },
      });

      if (!row) {
        throw new MilestoneActionRefusedError("NOT_FOUND", "Milestone not found.");
      }

      const check = checkMilestoneTransition(options.from, options.to);

      if (!check.allowed) {
        throw new MilestoneActionRefusedError("INVALID_STATE", check.reason);
      }

      const updated = await tx.milestone.updateMany({
        where: { id: options.milestoneId, status: options.from },
        data: {
          status: options.to,
          ...(options.data ?? {}),
        },
      });

      if (updated.count === 0) {
        const current = await tx.milestone.findUnique({
          where: { id: options.milestoneId },
          select: { status: true },
        });

        if (current?.status === options.to) {
          // Idempotent replay of the same logical action.
          return current.status as MilestoneState;
        }

        throw new MilestoneActionRefusedError(
          "CONCURRENT_CONFLICT",
          current
            ? `Milestone is now ${current.status}; expected ${options.from}.`
            : "Milestone not found.",
        );
      }

      await recordEvent(tx, {
        milestoneId: options.milestoneId,
        agreementId: row.agreementId,
        eventType: options.eventType,
        actor: options.actor,
        actorId: options.actorId,
        source: options.source,
        details: options.details,
        idempotencyKey: options.eventKey,
      });

      return options.to;
    });

    return {
      ok: true,
      milestoneId: options.milestoneId,
      status,
      idempotentReplay: false,
    };
  } catch (error) {
    if (error instanceof MilestoneActionRefusedError) {
      return { ok: false, code: error.code, reason: error.message };
    }

    console.error("runMilestoneTransition failed", error);

    return {
      ok: false,
      code: "CONCURRENT_CONFLICT",
      reason: "Could not complete the milestone action.",
    };
  }
}

// ---------------------------------------------------------------------------
// Creator submission → verification → first review window
// ---------------------------------------------------------------------------

/**
 * Attach a VERIFIED post to a PENDING milestone and open the first 24h
 * advertiser review window. Two hard gates apply:
 *
 *   1. PROVIDER-VERIFIED FUNDING — the agreement's obligation must hold
 *      verified escrow (the creator is never authorized to start against
 *      unverified funding);
 *   2. PLATFORM VERIFICATION — Stage 9 must already have confirmed this
 *      exact post (ownership, platform, deliverable link integrity).
 *
 * LOW VIEWS/LIKES/COMMENTS play no role here or anywhere downstream.
 */
export async function openMilestoneReviewAfterVerification(
  milestoneId: string,
  postId: string,
): Promise<MilestoneActionResult> {
  const milestone = await prisma.milestone.findUnique({
    where: { id: milestoneId },
    select: {
      id: true,
      agreementId: true,
      campaignId: true,
      status: true,
      paidPostId: true,
    },
  });

  if (!milestone) {
    return { ok: false, code: "NOT_FOUND", reason: "Milestone not found." };
  }

  const post = await prisma.campaignPost.findUnique({
    where: { id: postId },
    select: { id: true, status: true, campaignId: true },
  });

  if (!post || post.campaignId !== milestone.campaignId) {
    return { ok: false, code: "NOT_FOUND", reason: "Post not found for this campaign." };
  }

  if (post.status !== "VERIFIED") {
    // Platform verification is the gate — a merely submitted post can never
    // start an advertiser review window.
    return {
      ok: false,
      code: "POST_NOT_VERIFIED",
      reason: "Platform verification has not confirmed this post yet.",
    };
  }

  const now = new Date();

  try {
    // Funding gate (rule 4: no starting/publishing against unverified
    // funding). Inside the try so refusals surface as results, not throws.
    await assertFundingVerified(milestone.agreementId);

    const status = await prisma.$transaction(async (tx) => {
      const row = await tx.milestone.findUnique({
        where: { id: milestoneId },
      });

      if (!row) {
        throw new MilestoneActionRefusedError("NOT_FOUND", "Milestone not found.");
      }

      // Idempotent replay: this post already opened this review window.
      if (row.paidPostId === postId && row.status === "VERIFIED_PENDING_REVIEW") {
        return { state: "VERIFIED_PENDING_REVIEW" as MilestoneState, replay: true, reviewOpened: false };
      }

      if (row.status !== "PENDING") {
        throw new MilestoneActionRefusedError(
          "INVALID_STATE",
          "This milestone is not awaiting a first submission.",
        );
      }

      const check = checkMilestoneTransition("PENDING", "VERIFIED_PENDING_REVIEW");

      if (!check.allowed) {
        throw new MilestoneActionRefusedError("INVALID_STATE", check.reason);
      }

      // DETERMINISTIC ASSOCIATION: this exact verified post fulfills this
      // exact milestone. The submission row was already created at submission
      // time (13C); here we only stamp its verification result immutably.
      const submission = await tx.milestoneSubmission.findUnique({
        where: { postId },
        select: { id: true, sequence: true, verificationStatus: true },
      });

      if (!submission) {
        // No explicit association exists — never guess one. Preserve the
        // verification result, record the unresolved association, authorize
        // neither review nor settlement.
        await tx.milestoneEvent.create({
          data: {
            milestoneId,
            agreementId: row.agreementId,
            eventType: "milestone_missing_association" as never,
            actor: "SYSTEM",
            actorId: null,
            source: "milestone-review",
            details: {
              postId,
              reason: "Verified post has no explicit milestone submission association.",
            },
            idempotencyKey: `mevt:${milestoneId}:missing_association:${postId}`,
          },
        });

        throw new MilestoneActionRefusedError(
          "MISSING_POST",
          "This verified post has no explicit milestone submission association — review cannot open.",
        );
      }

      // Stamp THIS submission's verification result (its row is immutable in
      // every other respect).
      await tx.milestoneSubmission.updateMany({
        where: { id: submission.id, verificationStatus: { not: "VERIFIED" } },
        data: { verificationStatus: "VERIFIED", verifiedAt: now },
      });

      // Multi-post completion check: ALL required posts must be VERIFIED
      // before advertiser review may open — never after 1 of 3.
      const requiredCount = Math.max(1, row.requiredPostCount ?? 1);

      const verifiedCount = await tx.milestoneSubmission.count({
        where: { milestoneId, verificationStatus: "VERIFIED" },
      });

      if (verifiedCount < requiredCount) {
        // Milestone remains PENDING; the verification result is preserved and
        // the completion progress is visible to both parties.
        await recordEvent(tx, {
          milestoneId,
          agreementId: row.agreementId,
          eventType: "milestone_submission_verified",
          actor: "SYSTEM",
          actorId: null,
          source: "milestone-review",
          details: {
            postId,
            submissionSequence: submission.sequence,
            verifiedCount,
            requiredCount,
            note: "Milestone remains incomplete — required posts not all verified yet.",
          },
          idempotencyKey: `mevt:${milestoneId}:submission_verified:${postId}`,
        });

        return { state: "PENDING" as MilestoneState, replay: false, reviewOpened: false };
      }

      // All required posts verified — open the advertiser review window from
      // the server-side verification timestamp. NO auto-release exists.
      const bound = await tx.milestone.updateMany({
        where: { id: milestoneId, status: "PENDING" },
        data: {
          paidPostId: postId,
          status: "VERIFIED_PENDING_REVIEW",
          reviewWindowOpenedAt: now,
          reviewWindowDeadlineAt: reviewWindowDeadline(now),
          reviewPausedAt: null,
        },
      });

      if (bound.count === 0) {
        throw new MilestoneActionRefusedError(
          "CONCURRENT_CONFLICT",
          "Milestone changed while opening the review window.",
        );
      }

      await recordEvent(tx, {
        milestoneId,
        agreementId: row.agreementId,
        eventType: "milestone_submission_verified",
        actor: "SYSTEM",
        actorId: null,
        source: "milestone-review",
        details: { postId, submissionSequence: submission.sequence, verifiedCount, requiredCount },
        idempotencyKey: `mevt:${milestoneId}:submission_verified:${postId}`,
      });

      await recordEvent(tx, {
        milestoneId,
        agreementId: row.agreementId,
        eventType: "milestone_review_opened",
        actor: "SYSTEM",
        actorId: null,
        source: "milestone-review",
        details: {
          postId,
          openedAt: now.toISOString(),
          deadlineAt: reviewWindowDeadline(now).toISOString(),
          windowHours: 24,
        },
        idempotencyKey: `mevt:${milestoneId}:review_window_opened:${now.getTime()}`,
      });

      return { state: "VERIFIED_PENDING_REVIEW" as MilestoneState, replay: false, reviewOpened: true };
    });

    return {
      ok: true,
      milestoneId,
      status: status.state,
      idempotentReplay: status.replay,
      reviewOpened: status.reviewOpened,
    };
  } catch (error) {
    if (error instanceof MilestoneActionRefusedError) {
      return { ok: false, code: error.code, reason: error.message };
    }

    if (isUniqueViolation(error)) {
      // The post is already bound (to this or another milestone).
      return {
        ok: false,
        code: "INVALID_STATE",
        reason: "This post is already attached to a milestone.",
      };
    }

    console.error("openMilestoneReviewAfterVerification failed", error);

    return {
      ok: false,
      code: "CONCURRENT_CONFLICT",
      reason: "Could not open the milestone review.",
    };
  }
}

// ---------------------------------------------------------------------------
// Advertiser confirmation → release
// ---------------------------------------------------------------------------

export type ConfirmReleaseResult =
  | MilestoneActionResult
  | {
      ok: true;
      milestoneId: string;
      status: MilestoneState;
      idempotentReplay: boolean;
      settled: boolean;
      settlementCode?: string;
      settlementReason?: string;
    };

/**
 * Advertiser clicks "Confirm & Release Payment": record the immutable audit
 * facts, freeze the confirmation timestamp, move CONFIRMED_RELEASE, then
 * settle through the Stage 13A layer (which enforces funding + the dispute
 * freeze and writes the earned ledger lines from the frozen milestone row).
 */
export async function confirmMilestoneRelease(
  milestoneId: string,
  actor: { advertiserProfileId: string; userId: string },
): Promise<ConfirmReleaseResult> {
  const milestone = await prisma.milestone.findUnique({
    where: { id: milestoneId },
    select: { id: true, advertiserId: true, status: true, reviewWindowDeadlineAt: true },
  });

  if (!milestone) {
    return { ok: false, code: "NOT_FOUND", reason: "Milestone not found." };
  }

  // Prevent confirming another advertiser's milestone.
  if (milestone.advertiserId !== actor.advertiserProfileId) {
    return {
      ok: false,
      code: "UNAUTHORIZED",
      reason: "This milestone is not yours to confirm.",
    };
  }

  const now = new Date();

  const transition = await runMilestoneTransition({
    milestoneId,
    from: "VERIFIED_PENDING_REVIEW",
    to: "CONFIRMED_RELEASE",
    cause: "advertiser_confirmed",
    actor: "ADVERTISER",
    actorId: actor.userId,
    source: "milestone-review",
    eventType: "confirmed_release",
    details: {
      confirmedAt: now.toISOString(),
      confirmedBy: actor.userId,
      // Advertiser-delay accounting only — never creator lateness.
      confirmedAfterDeadline:
        milestone.reviewWindowDeadlineAt != null &&
        now.getTime() > milestone.reviewWindowDeadlineAt.getTime(),
    },
    eventKey: `mevt:${milestoneId}:confirmed_release`,
  });

  if (!transition.ok) {
    // Duplicate confirmation (already confirmed/released) is an idempotent
    // no-op, not an error — replays must be safe.
    const current = await prisma.milestone.findUnique({
      where: { id: milestoneId },
      select: { status: true },
    });

    if (
      current?.status === "CONFIRMED_RELEASE" ||
      current?.status === "SETTLEMENT_PENDING" ||
      current?.status === "RELEASED"
    ) {
      return {
        ok: true,
        milestoneId,
        status: current.status as MilestoneState,
        idempotentReplay: true,
        settled: current.status === "RELEASED",
      };
    }

    // A milestone whose deliverables were never verified/confirmed is simply
    // not in a confirmable state — report the domain rule, not a concurrency
    // accident.
    if (transition.code === "CONCURRENT_CONFLICT" && current) {
      return { ok: false, code: "INVALID_STATE", reason: transition.reason };
    }

    return transition;
  }

  const settlement = await settleConfirmedMilestone(milestoneId, {
    role: "ADVERTISER",
    actorId: actor.advertiserProfileId,
    source: "milestone-review",
  });

  return {
    ok: true,
    milestoneId,
    status: settlement.ok ? "RELEASED" : "CONFIRMED_RELEASE",
    idempotentReplay: false,
    settled: settlement.ok,
    settlementCode: settlement.ok ? undefined : settlement.code,
    settlementReason: settlement.ok ? undefined : settlement.reason,
  };
}

// ---------------------------------------------------------------------------
// Correction flow (first path — NOT a dispute)
// ---------------------------------------------------------------------------

/**
 * Advertiser requests a correction. Records the advertiser id, timestamp,
 * reason/details, current state and review-timer state, then pauses the
 * window. The creator is NOT considered late because of this — the pause is
 * what keeps advertiser-side delay off the creator's record.
 */
export async function requestMilestoneCorrection(
  milestoneId: string,
  actor: { advertiserProfileId: string; userId: string },
  input: { note: string },
): Promise<MilestoneActionResult> {
  const note = input.note.trim();

  if (note.length < 10 || note.length > 2000) {
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      reason: "Describe the correction in 10–2000 characters.",
    };
  }

  const milestone = await prisma.milestone.findUnique({
    where: { id: milestoneId },
    select: { id: true, advertiserId: true },
  });

  if (!milestone) {
    return { ok: false, code: "NOT_FOUND", reason: "Milestone not found." };
  }

  if (milestone.advertiserId !== actor.advertiserProfileId) {
    return { ok: false, code: "UNAUTHORIZED", reason: "This milestone is not yours." };
  }

  const now = new Date();

  return runMilestoneTransition({
    milestoneId,
    from: "VERIFIED_PENDING_REVIEW",
    to: "CORRECTION_REQUESTED",
    cause: "correction_requested",
    actor: "ADVERTISER",
    actorId: actor.userId,
    source: "milestone-review",
    eventType: "correction_requested",
    details: {
      note,
      requestedAt: now.toISOString(),
      timerState: "PAUSED",
    },
    eventKey: `mevt:${milestoneId}:correction_requested:${now.getTime()}`,
    data: {
      reviewPausedAt: now,
      correctionCount: { increment: 1 },
      correctionRequestedAt: now,
      correctionRequestedBy: actor.userId,
      correctionRequestNote: note,
    },
  });
}

/**
 * Creator resubmits the corrected post: CORRECTION_REQUESTED →
 * PENDING_REVERIFICATION. The new post must belong to this creator and this
 * campaign; platform re-verification may still be pending at bind time (the
 * state machine's PENDING_REVERIFICATION exists precisely for that window).
 * Duplicate resubmissions with the same post are refused.
 */
export async function submitMilestoneCorrection(
  milestoneId: string,
  actor: { creatorProfileId: string; userId: string },
  postId: string,
): Promise<MilestoneActionResult> {
  const milestone = await prisma.milestone.findUnique({
    where: { id: milestoneId },
    select: {
      id: true,
      agreementId: true,
      campaignId: true,
      creatorId: true,
      reviewPausedAt: true,
    },
  });

  if (!milestone) {
    return { ok: false, code: "NOT_FOUND", reason: "Milestone not found." };
  }

  if (milestone.creatorId !== actor.creatorProfileId) {
    return { ok: false, code: "UNAUTHORIZED", reason: "This milestone is not yours." };
  }

  const post = await prisma.campaignPost.findUnique({
    where: { id: postId },
    select: { id: true, campaignId: true, creatorId: true },
  });

  if (!post || post.creatorId !== actor.creatorProfileId || post.campaignId !== milestone.campaignId) {
    return { ok: false, code: "NOT_FOUND", reason: "Post not found for this campaign." };
  }

  const now = new Date();

  try {
    const status = await prisma.$transaction(async (tx) => {
      const row = await tx.milestone.findUnique({
        where: { id: milestoneId },
      });

      if (!row) {
        throw new MilestoneActionRefusedError("NOT_FOUND", "Milestone not found.");
      }

      if (row.status !== "CORRECTION_REQUESTED") {
        throw new MilestoneActionRefusedError(
          "INVALID_STATE",
          "This milestone is not waiting for a correction.",
        );
      }

      const check = checkMilestoneTransition("CORRECTION_REQUESTED", "PENDING_REVERIFICATION");

      if (!check.allowed) {
        throw new MilestoneActionRefusedError("INVALID_STATE", check.reason);
      }

      // Duplicate correction protection: the same post can never be
      // resubmitted twice (unique postId in the submission history).
      const alreadySubmitted = await tx.milestoneSubmission.findUnique({
        where: { postId },
        select: { id: true },
      });

      if (alreadySubmitted) {
        throw new MilestoneActionRefusedError(
          "VALIDATION_FAILED",
          "This corrected post is already attached — the resubmission was already recorded.",
        );
      }

      // Determine the next immutable sequence and capture the correction
      // request that caused this resubmission (from the denormalized
      // milestone fields, copied onto the submission row so the chain is
      // self-contained evidence).
      const lastSubmission = await tx.milestoneSubmission.findFirst({
        where: { milestoneId },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });

      const sequence = (lastSubmission?.sequence ?? 0) + 1;

      // Account for the paused span (advertiser + platform delay bookkeeping
      // — this is never interpreted as creator lateness).
      const pausedSeconds = row.reviewPausedAt
        ? pausedSecondsBetween(row.reviewPausedAt, now)
        : 0;

      // APPEND a new immutable submission — the previous submission row and
      // its post reference are never modified or deleted.
      await tx.milestoneSubmission.create({
        data: {
          milestoneId,
          agreementId: row.agreementId,
          sequence,
          postId,
          submittedById: actor.userId,
          verificationStatus: "SUBMITTED",
          causedByCorrectionRequestNote: row.correctionRequestNote,
          causedByCorrectionRequestedBy: row.correctionRequestedBy,
          causedByCorrectionRequestedAt: row.correctionRequestedAt,
        },
      });

      // Then update the mutable milestone state: point the convenience
      // pointer at the new submission's post and move to re-verification.
      await tx.milestone.updateMany({
        where: { id: milestoneId, status: "CORRECTION_REQUESTED" },
        data: {
          status: "PENDING_REVERIFICATION",
          paidPostId: postId,
          correctionSubmittedAt: now,
          correctionSubmittedBy: actor.userId,
          reviewPausedAt: null,
          totalPausedSeconds: { increment: pausedSeconds },
        },
      });

      await recordEvent(tx, {
        milestoneId,
        agreementId: row.agreementId,
        eventType: "correction_submitted",
        actor: "CREATOR",
        actorId: actor.userId,
        source: "milestone-review",
        details: {
          postId,
          submissionSequence: sequence,
          correctionRequestNote: row.correctionRequestNote,
          submittedAt: now.toISOString(),
          pausedSeconds,
        },
        idempotencyKey: `mevt:${milestoneId}:correction_submitted:${postId}`,
      });

      return "PENDING_REVERIFICATION" as MilestoneState;
    });

    return { ok: true, milestoneId, status, idempotentReplay: false };
  } catch (error) {
    if (error instanceof MilestoneActionRefusedError) {
      return { ok: false, code: error.code, reason: error.message };
    }

    if (isUniqueViolation(error)) {
      return {
        ok: false,
        code: "VALIDATION_FAILED",
        reason: "This post is already attached to a milestone.",
      };
    }

    console.error("submitMilestoneCorrection failed", error);

    return {
      ok: false,
      code: "CONCURRENT_CONFLICT",
      reason: "Could not submit the correction.",
    };
  }
}

/**
 * Re-verification completed: PENDING_REVERIFICATION → VERIFIED_PENDING_REVIEW
 * with a FRESH 24h window. Requires the bound post to actually be VERIFIED
 * (Stage 9). Failure keeps the milestone in PENDING_REVERIFICATION
 * (retryable via the sweep) — never auto-cancels, never auto-releases.
 */
export async function completeMilestoneReverification(
  milestoneId: string,
): Promise<MilestoneActionResult> {
  const milestone = await prisma.milestone.findUnique({
    where: { id: milestoneId },
    select: { id: true, agreementId: true, status: true, paidPostId: true },
  });

  if (!milestone) {
    return { ok: false, code: "NOT_FOUND", reason: "Milestone not found." };
  }

  if (!milestone.paidPostId) {
    return { ok: false, code: "MISSING_POST", reason: "No corrected post is attached." };
  }

  const post = await prisma.campaignPost.findUnique({
    where: { id: milestone.paidPostId },
    select: { status: true },
  });

  if (!post || post.status !== "VERIFIED") {
    return {
      ok: false,
      code: "POST_NOT_VERIFIED",
      reason: "Platform verification has not confirmed the corrected post yet.",
    };
  }

  const now = new Date();

  // Target state is computed inside the transaction after the multi-post
  // completion check: VERIFIED_PENDING_REVIEW when all required posts are
  // verified again, otherwise PENDING (deliverables still incomplete).
  let targetStatus: "PENDING" | "VERIFIED_PENDING_REVIEW" = "VERIFIED_PENDING_REVIEW";

  try {
    const status = await prisma.$transaction(async (tx) => {
      const row = await tx.milestone.findUnique({
        where: { id: milestoneId },
      });

      if (!row) {
        throw new MilestoneActionRefusedError("NOT_FOUND", "Milestone not found.");
      }

      if (row.status !== "PENDING_REVERIFICATION") {
        throw new MilestoneActionRefusedError(
          "INVALID_STATE",
          "This milestone is not awaiting re-verification.",
        );
      }

      const check = checkMilestoneTransition("PENDING_REVERIFICATION", "VERIFIED_PENDING_REVIEW");

      if (!check.allowed) {
        throw new MilestoneActionRefusedError("INVALID_STATE", check.reason);
      }

      const nextStatus = targetStatus as MilestoneState;

      const updated = await tx.milestone.updateMany({
        where: { id: milestoneId, status: "PENDING_REVERIFICATION" },
        data: {
          status: nextStatus,
          reviewWindowOpenedAt: now,
          reviewWindowDeadlineAt: reviewWindowDeadline(now),
          reviewPausedAt: null,
        },
      });

      if (updated.count === 0) {
        throw new MilestoneActionRefusedError(
          "CONCURRENT_CONFLICT",
          "Milestone changed during re-verification completion.",
        );
      }

      // Stamp THIS submission's verification result on its immutable row.
      if (row.paidPostId) {
        await tx.milestoneSubmission.updateMany({
          where: { milestoneId, postId: row.paidPostId },
          data: { verificationStatus: "VERIFIED", verifiedAt: now },
        });
      }

      // Multi-post completion re-check after a correction round.
      const requiredCount = Math.max(1, row.requiredPostCount ?? 1);
      const verifiedCount = await tx.milestoneSubmission.count({
        where: { milestoneId, verificationStatus: "VERIFIED" },
      });

      await recordEvent(tx, {
        milestoneId,
        agreementId: row.agreementId,
        eventType: "milestone_reverified",
        actor: "SYSTEM",
        actorId: null,
        source: "milestone-review",
        details: { reverified: true, postId: row.paidPostId, verifiedCount, requiredCount },
        idempotencyKey: `mevt:${milestoneId}:reverified:${row.paidPostId}:${now.getTime()}`,
      });

      if (verifiedCount < requiredCount) {
        // A correction round replaced one of several required posts; the
        // milestone cannot reopen review until all are verified again.
        targetStatus = "PENDING";
        return "PENDING" as MilestoneState;
      }

      await recordEvent(tx, {
        milestoneId,
        agreementId: row.agreementId,
        eventType: "review_window_opened",
        actor: "SYSTEM",
        actorId: null,
        source: "milestone-review",
        details: {
          reopenedAfterCorrection: true,
          openedAt: now.toISOString(),
          deadlineAt: reviewWindowDeadline(now).toISOString(),
          windowHours: 24,
        },
        idempotencyKey: `mevt:${milestoneId}:review_window_opened:${now.getTime()}`,
      });

      return "VERIFIED_PENDING_REVIEW" as MilestoneState;
    });

    return { ok: true, milestoneId, status, idempotentReplay: false };
  } catch (error) {
    if (error instanceof MilestoneActionRefusedError) {
      return { ok: false, code: error.code, reason: error.message };
    }

    console.error("completeMilestoneReverification failed", error);

    return {
      ok: false,
      code: "CONCURRENT_CONFLICT",
      reason: "Could not complete re-verification.",
    };
  }
}

// ---------------------------------------------------------------------------
// Support escalation + explicit, audited decisions
// ---------------------------------------------------------------------------

/**
 * Escalate to support (advertiser or creator, from their own milestone).
 * Records who escalated, why, and pauses the timer. Funds remain
 * provider-held: the 13A obligation keeps its dispute-freeze semantics and
 * only an explicit support decision can move things forward.
 */
export async function escalateMilestoneToSupport(
  milestoneId: string,
  actor: PartyActor,
  input: { reason: string },
): Promise<MilestoneActionResult> {
  const reason = input.reason.trim();

  if (reason.length < 10 || reason.length > 2000) {
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      reason: "Describe the issue in 10–2000 characters.",
    };
  }

  const milestone = await prisma.milestone.findUnique({
    where: { id: milestoneId },
    select: {
      id: true,
      advertiserId: true,
      creatorId: true,
    },
  });

  if (!milestone) {
    return { ok: false, code: "NOT_FOUND", reason: "Milestone not found." };
  }

  const authorized =
    (actor.kind === "ADVERTISER" && milestone.advertiserId === actor.advertiserProfileId) ||
    (actor.kind === "CREATOR" && milestone.creatorId === actor.creatorProfileId);

  if (!authorized) {
    return {
      ok: false,
      code: "UNAUTHORIZED",
      reason: "Only a party to this agreement can escalate.",
    };
  }

  const now = new Date();

  return runMilestoneTransition({
    milestoneId,
    from: "VERIFIED_PENDING_REVIEW",
    to: "SUPPORT_REVIEW",
    cause: "escalated_support",
    actor: actor.kind,
    actorId: actor.userId,
    source: "milestone-review",
    eventType: "escalated_support",
    details: {
      reason,
      escalatedAt: now.toISOString(),
      escalatedByRole: actor.kind,
    },
    eventKey: `mevt:${milestoneId}:escalated_support:${now.getTime()}`,
    data: {
      reviewPausedAt: now,
      supportEscalatedAt: now,
      supportEscalatedBy: actor.userId,
      supportEscalationReason: reason,
    },
  });
}

// ---------------------------------------------------------------------------
// Submission history (immutable) — party + support reads
// ---------------------------------------------------------------------------

export type SubmissionHistoryRow = {
  id: string;
  sequence: number;
  postId: string;
  submittedById: string | null;
  submittedAt: Date;
  verificationStatus: string;
  verifiedAt: Date | null;
  causedByCorrectionRequestNote: string | null;
  causedByCorrectionRequestedBy: string | null;
  causedByCorrectionRequestedAt: Date | null;
};

/**
 * The complete, immutable submission chain for one milestone: every
 * submission (original + each correction), its timestamps, its verification
 * result and the correction request that caused each resubmission. Rows are
 * appended only — nothing here is ever rewritten, so this is the evidence of
 * record for support review. Only parties to the agreement may read it.
 */
export async function getMilestoneSubmissionHistory(
  milestoneId: string,
  viewer: { advertiserId?: string; creatorId?: string },
): Promise<SubmissionHistoryRow[] | null> {
  const milestone = await prisma.milestone.findFirst({
    where: {
      id: milestoneId,
      ...(viewer.advertiserId !== undefined ? { advertiserId: viewer.advertiserId } : {}),
      ...(viewer.creatorId !== undefined ? { creatorId: viewer.creatorId } : {}),
    },
    select: { id: true },
  });

  if (!milestone) {
    return null;
  }

  const rows = await prisma.milestoneSubmission.findMany({
    where: { milestoneId },
    orderBy: { sequence: "asc" },
    select: {
      id: true,
      sequence: true,
      postId: true,
      submittedById: true,
      submittedAt: true,
      verificationStatus: true,
      verifiedAt: true,
      causedByCorrectionRequestNote: true,
      causedByCorrectionRequestedBy: true,
      causedByCorrectionRequestedAt: true,
    },
  });

  return rows;
}

// ---------------------------------------------------------------------------
// Support authorization (trusted roster seam)
// ---------------------------------------------------------------------------

/**
 * SUPPORT authorization boundary.
 *
 * Agenda has no admin ROLE architecture yet (User.role is CREATOR |
 * ADVERTISER only), so support authorization uses an explicit trusted seam:
 * the operator-maintained support roster (`User.supportRosterMember`, set by
 * SQL INSERT exactly like PlatformFeeConfig — no client, route or UI path can
 * write it).
 *
 * Properties:
 *   - FAIL-CLOSED: an empty roster authorizes NOBODY.
 *   - Ordinary advertisers/creators are refused even when fully
 *     authenticated — authentication is NOT support authorization.
 *   - The acting user id ALWAYS comes from the server session (the route/
 *     action passes `session.user.id`); a client cannot forge an actor id.
 *   - When the Stage 14 admin role lands, swap this check for requireRole —
 *     nothing else changes.
 */
export async function isSupportActor(userId: string): Promise<boolean> {
  if (!userId) {
    return false;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { supportRosterMember: true },
  });

  return user?.supportRosterMember === true;
}

/** Refusal raised when a non-support actor attempts a support action. */
export class SupportAuthorizationError extends Error {
  constructor(message = "Support authorization required.") {
    super(message);
    this.name = "SupportAuthorizationError";
  }
}

export type SupportDecision =
  | "RELEASE_PAYMENT"
  | "REQUEST_CORRECTION"
  | "CANCEL_AFFECTED_WORK"
  | "FURTHER_REVIEW";

export type SupportDecisionResult =
  | {
      ok: true;
      milestoneId: string;
      status: MilestoneState;
      idempotentReplay: boolean;
      settled?: boolean;
      settlementCode?: string;
      settlementReason?: string;
    }
  | { ok: false; code: MilestoneErrorCode; reason: string };

/**
 * Record an explicit, audited support decision. Support can NEVER change
 * financial amounts through this path — amounts stay frozen on the milestone
 * row; a release settles exactly the frozen figures through the 13A layer.
 *
 * AUTHORIZATION: `actor.userId` MUST be the raw server-session user id (the
 * calling route/action passes it through; a client can never supply or forge
 * it). Authorization is then verified against the operator-maintained support
 * roster (User.supportRosterMember) — authentication alone is NOT enough, so
 * an ordinary advertiser or creator can never invoke a support decision (see
 * isSupportActor). Fail-closed: an empty roster authorizes nobody.
 *
 * Outcomes:
 *   RELEASE_PAYMENT        → SETTLEMENT_PENDING, then settled via 13A
 *   REQUEST_CORRECTION     → CORRECTION_REQUESTED (back to the creator)
 *   CANCEL_AFFECTED_WORK   → VALID_CANCELLATION (terminal; no fees earned)
 *   FURTHER_REVIEW         → stays in SUPPORT_REVIEW (audited)
 */
export async function recordSupportDecision(
  milestoneId: string,
  actor: SupportActor,
  input: { decision: SupportDecision; reason: string; evidenceRefs?: string[] },
): Promise<SupportDecisionResult> {
  if (!actor.authenticated || !actor.userId) {
    return {
      ok: false,
      code: "UNAUTHORIZED",
      reason: "Support actor is not authenticated.",
    };
  }

  // Authorization ≠ authentication: only roster members may act as SUPPORT.
  const onRoster = await isSupportActor(actor.userId);

  if (!onRoster) {
    return {
      ok: false,
      code: "UNAUTHORIZED",
      reason: "Support authorization required.",
    };
  }

  const reason = input.reason.trim();

  if (reason.length < 10 || reason.length > 2000) {
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      reason: "Provide a decision reason of 10–2000 characters.",
    };
  }

  const milestone = await prisma.milestone.findUnique({
    where: { id: milestoneId },
    select: { id: true, agreementId: true, status: true },
  });

  if (!milestone) {
    return { ok: false, code: "NOT_FOUND", reason: "Milestone not found." };
  }

  if (milestone.status !== "SUPPORT_REVIEW") {
    return {
      ok: false,
      code: "INVALID_STATE",
      reason: "Only escalated milestones can receive a support decision.",
    };
  }

  const now = new Date();

  const targets: Record<SupportDecision, MilestoneState> = {
    RELEASE_PAYMENT: "SETTLEMENT_PENDING",
    REQUEST_CORRECTION: "CORRECTION_REQUESTED",
    CANCEL_AFFECTED_WORK: "VALID_CANCELLATION",
    FURTHER_REVIEW: "SUPPORT_REVIEW",
  };

  const to = targets[input.decision];

  try {
    const status = await prisma.$transaction(async (tx) => {
      const row = await tx.milestone.findUnique({
        where: { id: milestoneId },
      });

      if (!row || row.status !== "SUPPORT_REVIEW") {
        throw new MilestoneActionRefusedError(
          "INVALID_STATE",
          "Milestone is no longer in support review.",
        );
      }

      const updated = await tx.milestone.updateMany({
        where: { id: milestoneId, status: "SUPPORT_REVIEW" },
        data: {
          status: to,
          supportDecidedAt: now,
          supportDecisionById: actor.userId,
          supportDecision: input.decision,
          supportDecisionNote: reason,
          reviewPausedAt: null,
          // The correction path re-uses the advertiser correction fields so
          // the creator sees one consistent "what to fix" record.
          ...(input.decision === "REQUEST_CORRECTION"
            ? {
                correctionCount: { increment: 1 },
                correctionRequestedAt: now,
                correctionRequestedBy: `support:${actor.userId}`,
                correctionRequestNote: reason,
              }
            : {}),
          ...(input.decision === "CANCEL_AFFECTED_WORK" ? { cancelledAt: now } : {}),
        },
      });

      if (updated.count === 0) {
        throw new MilestoneActionRefusedError(
          "CONCURRENT_CONFLICT",
          "Milestone moved during the support decision.",
        );
      }

      await recordEvent(tx, {
        milestoneId,
        agreementId: row.agreementId,
        eventType:
          input.decision === "CANCEL_AFFECTED_WORK" ? "cancelled_valid" : "support_decision",
        actor: "SUPPORT",
        actorId: actor.userId,
        source: actor.source,
        details: {
          decision: input.decision,
          reason,
          evidenceRefs: input.evidenceRefs ?? [],
          from: "SUPPORT_REVIEW",
          to,
        },
        idempotencyKey: `mevt:${milestoneId}:support_decision:${input.decision}:${now.getTime()}`,
      });

      return to;
    });

    // RELEASE_PAYMENT continues into settlement through the 13A layer with
    // the same funding gates and frozen amounts as the advertiser path.
    if (input.decision === "RELEASE_PAYMENT") {
      const settle = await settleConfirmedMilestone(milestoneId, {
        role: "ADMIN",
        actorId: actor.userId,
        source: actor.source,
      });

      return {
        ok: true,
        milestoneId,
        status: settle.ok ? "RELEASED" : "SETTLEMENT_PENDING",
        idempotentReplay: false,
        settled: settle.ok,
        settlementCode: settle.ok ? undefined : settle.code,
        settlementReason: settle.ok ? undefined : settle.reason,
      };
    }

    return { ok: true, milestoneId, status, idempotentReplay: false };
  } catch (error) {
    if (error instanceof MilestoneActionRefusedError) {
      return { ok: false, code: error.code, reason: error.message };
    }

    console.error("recordSupportDecision failed", error);

    return {
      ok: false,
      code: "CONCURRENT_CONFLICT",
      reason: "Could not record the support decision.",
    };
  }
}

// ---------------------------------------------------------------------------
// Sweeps (cron): advertiser-delay recording + re-verification completion
// ---------------------------------------------------------------------------

export type MilestoneSweepReport = {
  ranAt: string;
  delaysRecorded: number;
  /** Windows routed to SUPPORT_REVIEW after expiry (never auto-released). */
  expiredToSupport: number;
  reverificationsCompleted: number;
  /** Always false: no automatic release exists in any sweep path. */
  autoReleasePerformed: false;
};

/**
 * Scheduled sweep. Two responsibilities, neither ever moves money:
 *
 *   1. Record advertiser-caused delay for overdue RUNNING review windows
 *      (one idempotent event per window). This is evidence for the delay
 *      rules — it NEVER changes milestone state and NEVER penalizes the
 *      creator.
 *   2. Complete re-verification for milestones whose corrected post has
 *      since become VERIFIED (opens the fresh 24h window).
 */
export async function sweepMilestoneTimers(options: { now?: Date } = {}): Promise<MilestoneSweepReport> {
  const now = options.now ?? new Date();
  let delaysRecorded = 0;
  let expiredToSupport = 0;
  let reverificationsCompleted = 0;

  // 1. Advertiser-delay evidence for overdue running windows.
  const overdue = await prisma.milestone.findMany({
    where: {
      status: "VERIFIED_PENDING_REVIEW",
      reviewWindowDeadlineAt: { lt: now },
    },
    select: {
      id: true,
      agreementId: true,
      reviewWindowOpenedAt: true,
      reviewWindowDeadlineAt: true,
    },
    take: 200,
  });

  for (const milestone of overdue) {
    if (milestone.reviewWindowOpenedAt === null || milestone.reviewWindowDeadlineAt === null) {
      continue;
    }

    try {
      await prisma.milestoneEvent.create({
        data: {
          milestoneId: milestone.id,
          agreementId: milestone.agreementId,
          eventType: "advertiser_delay_recorded",
          actor: "SYSTEM",
          actorId: null,
          source: "milestone-sweep",
          details: {
            windowOpenedAt: milestone.reviewWindowOpenedAt.toISOString(),
            windowDeadlineAt: milestone.reviewWindowDeadlineAt.toISOString(),
            overdueBySeconds: pausedSecondsBetween(milestone.reviewWindowDeadlineAt, now),
            note: "Advertiser review window elapsed without a decision. Recorded as advertiser-caused delay; the creator is not considered late. No automatic release exists.",
          },
          // One delay event per window: idempotent across sweep runs.
          idempotencyKey: `mevt:${milestone.id}:advertiser_delay_recorded:${milestone.reviewWindowOpenedAt.getTime()}`,
        },
      });

      delaysRecorded += 1;
    } catch (error) {
      if (!isUniqueViolation(error)) {
        console.error("sweepMilestoneTimers:delay-record failed", error);
      }
      // Duplicate (already recorded for this window) — idempotent no-op.
    }

    // 13C: expiry ROUTES TO SUPPORT — the milestone leaves the running timer
    // state so nothing can ever release it unattended. This is the existing
    // Stage 13B escalation edge (VERIFIED_PENDING_REVIEW → SUPPORT_REVIEW);
    // funds stay provider-held and only explicit support decisions move it.
    const routed = await runMilestoneTransition({
      milestoneId: milestone.id,
      from: "VERIFIED_PENDING_REVIEW",
      to: "SUPPORT_REVIEW",
      cause: "escalated_support",
      actor: "SYSTEM",
      actorId: null,
      source: "milestone-sweep",
      eventType: "milestone_review_expired",
      details: {
        windowOpenedAt: milestone.reviewWindowOpenedAt.toISOString(),
        windowDeadlineAt: milestone.reviewWindowDeadlineAt.toISOString(),
        routedToSupport: true,
        note: "Advertiser review window expired without a decision. Routed to Support Review — no automatic release exists.",
      },
      eventKey: `mevt:${milestone.id}:review_expired:${milestone.reviewWindowOpenedAt.getTime()}`,
      data: {
        reviewPausedAt: now,
        supportEscalatedAt: now,
        supportEscalatedBy: "system:review-expiry",
        supportEscalationReason: "Advertiser review window expired without a decision (24h).",
      },
    });

    if (routed.ok) {
      expiredToSupport += 1;
    }
  }

  // 2. Complete re-verification for corrected posts that verified since.
  const pendingReverification = await prisma.milestone.findMany({
    where: { status: "PENDING_REVERIFICATION", paidPostId: { not: null } },
    select: { id: true, paidPostId: true },
    take: 200,
  });

  for (const milestone of pendingReverification) {
    const post = await prisma.campaignPost.findUnique({
      where: { id: milestone.paidPostId as string },
      select: { status: true },
    });

    if (post?.status === "VERIFIED") {
      const result = await completeMilestoneReverification(milestone.id);

      if (result.ok) {
        reverificationsCompleted += 1;
      }
    }
  }

  return {
    ranAt: now.toISOString(),
    delaysRecorded,
    expiredToSupport,
    reverificationsCompleted,
    autoReleasePerformed: false,
  };
}
