import type { MilestoneStatus } from "@/generated/prisma/client";

/**
 * Stage 13B — milestone display helpers (client-safe: no server-only imports).
 * All timer text is derived from server-frozen timestamps; refreshing the
 * page can never reset or manipulate it, and no "auto release" wording exists
 * anywhere because no automatic release exists.
 */

export const MILESTONE_STATUS_LABELS: Record<MilestoneStatus, string> = {
  PENDING: "Not submitted yet",
  VERIFIED_PENDING_REVIEW: "Verified — Pending Your Review",
  CORRECTION_REQUESTED: "Correction Requested",
  PENDING_REVERIFICATION: "Correction Submitted — Awaiting Verification",
  SUPPORT_REVIEW: "Support review in progress",
  CONFIRMED_RELEASE: "Release confirmed",
  SETTLEMENT_PENDING: "Settlement pending",
  RELEASED: "Payment released",
  VALID_CANCELLATION: "Cancelled — work not payable",
};

export const MILESTONE_STATUS_TONES: Record<
  MilestoneStatus,
  "accent" | "warning" | "danger" | "muted" | "neutral"
> = {
  PENDING: "muted",
  VERIFIED_PENDING_REVIEW: "accent",
  CORRECTION_REQUESTED: "warning",
  PENDING_REVERIFICATION: "warning",
  SUPPORT_REVIEW: "warning",
  CONFIRMED_RELEASE: "accent",
  SETTLEMENT_PENDING: "neutral",
  RELEASED: "accent",
  VALID_CANCELLATION: "danger",
};

/**
 * The advertiser's review-window line. There is deliberately NO auto-release:
 * after the deadline the message shifts to advertiser-delay language only.
 */
export function reviewWindowLine(
  status: MilestoneStatus,
  deadlineAt: Date | null,
  now: Date = new Date(),
): string {
  if (status !== "VERIFIED_PENDING_REVIEW" || !deadlineAt) {
    return "";
  }

  if (now.getTime() > deadlineAt.getTime()) {
    return "The 24-hour review window has elapsed. Take your time — nothing is released automatically; confirm, request a correction, or escalate when ready.";
  }

  const secondsLeft = Math.max(0, Math.floor((deadlineAt.getTime() - now.getTime()) / 1000));
  const hours = Math.floor(secondsLeft / 3600);
  const minutes = Math.floor((secondsLeft % 3600) / 60);

  return `Advertiser review window: ${hours}h ${minutes}m remaining. Nothing is released automatically when it ends.`;
}

/**
 * Neutral creator-facing correction copy: shows the advertiser's exact
 * request, never performance-based blame.
 */
export function creatorCorrectionLine(status: MilestoneStatus): string | null {
  if (status === "CORRECTION_REQUESTED") {
    return "Correction Requested — waiting for you to submit the corrected post.";
  }

  if (status === "PENDING_REVERIFICATION") {
    return "Correction Submitted — Awaiting Verification.";
  }

  return null;
}
