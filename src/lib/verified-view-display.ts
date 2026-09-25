import type { PostStatus } from "@/types";

import { formatCount, formatDateTime } from "@/lib/utils";

/**
 * Stage 9C — presentation helpers for verified-view data.
 *
 * Pure logic: no React, no Prisma, no network imports, so it is unit-testable
 * in isolation (same convention as the Stage 9A accounting module). Everything
 * here formats server-computed values passed in by server components:
 *
 *   - metrics exist ONLY for VERIFIED posts — pending/rejected posts render a
 *     dash, never a fabricated zero that could be mistaken for real data;
 *   - integrity REVIEW is a neutral flag ("additional verification required"),
 *     never fraud/bot language — the Stage 9A checks are objective data checks.
 */

/**
 * Clear, user-facing verification states mapped from PostStatus:
 *   AWAITING — submitted, verification has not run yet
 *   PENDING  — verification is running right now
 *   VERIFIED — the platform confirmed the post; metrics may be shown
 *   REJECTED — the submission failed verification rules (terminal)
 */
export type VerificationDisplayState =
  | "AWAITING"
  | "PENDING"
  | "VERIFIED"
  | "REJECTED";

export function getVerificationDisplayState(
  status: PostStatus,
): VerificationDisplayState {
  switch (status) {
    case "SUBMITTED":
      return "AWAITING";
    case "VERIFYING":
      return "PENDING";
    case "VERIFIED":
      return "VERIFIED";
    case "REJECTED":
      return "REJECTED";
  }
}

export const VERIFICATION_STATE_LABELS: Record<
  VerificationDisplayState,
  string
> = {
  AWAITING: "Awaiting verification",
  PENDING: "Verifying",
  VERIFIED: "Verified",
  REJECTED: "Rejected",
};

/**
 * Neutral integrity presentation for the latest verified observation.
 * Only CLEAN/REVIEW reach the UI: REJECTED observations never become the
 * latest VERIFIED observation (the orchestrator's gate blocks that path).
 */
export type VerificationIntegrity = "CLEAN" | "REVIEW";

export const INTEGRITY_LABELS: Record<VerificationIntegrity, string> = {
  CLEAN: "Clean",
  REVIEW: "REVIEW",
};

/**
 * Integrity footnotes. REVIEW states the objective fact only — an additional
 * verification is required — and never describes the post as fraud or bot
 * activity (Stage 9A checks are data-validity checks, not accusations).
 */
export const INTEGRITY_NOTES: Record<VerificationIntegrity, string | null> = {
  CLEAN: null,
  REVIEW:
    "Verification issue — additional verification required. The verified views shown are the platform's most recent confirmed count for this post.",
};

/**
 * True only when a real verification run has stored metrics for the post.
 * Unavailable verification data must never fall back to zero-valued metrics.
 */
export function hasVerifiedMetrics(status: PostStatus): boolean {
  return status === "VERIFIED";
}

/**
 * Format a metric for display. Non-verified posts render a dash — never a
 * "0" that could be read as a verified (or platform-reported) count.
 */
export function formatVerifiedMetric(
  status: PostStatus,
  value: number,
): string {
  return hasVerifiedMetrics(status) ? formatCount(value) : "—";
}

/**
 * "Last verified" timestamp label. Posts with no sync yet get a state-aware
 * placeholder instead of a fabricated date.
 */
export function getLastVerifiedLabel(
  lastSyncedAt: Date | string | null,
  status: PostStatus,
): string {
  if (lastSyncedAt) {
    return formatDateTime(lastSyncedAt);
  }

  const state = getVerificationDisplayState(status);

  return state === "AWAITING" || state === "PENDING"
    ? "Awaiting verification"
    : "Never";
}

/**
 * One-line note explaining why verified views are (or are not) shown.
 * Returns null for VERIFIED posts — the metrics speak for themselves.
 */
export function getVerifiedViewsNote(status: PostStatus): string | null {
  switch (getVerificationDisplayState(status)) {
    case "AWAITING":
      return "Awaiting verification — verified views stay hidden until the platform reports them.";
    case "PENDING":
      return "Verification is running against the platform right now. Metrics appear once it completes.";
    case "REJECTED":
      return "This submission did not meet the campaign's verification rules, so no verified views exist for it.";
    case "VERIFIED":
      return null;
  }
}
