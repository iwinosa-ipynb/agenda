/**
 * Stage 9 — verified-view accounting and integrity rules (pure logic).
 *
 * This module holds the deterministic core of verified-view accounting:
 *
 *   - validation of verifier-reported metrics (objective sanity checks only)
 *   - the high-water rule for cumulative platform view counts
 *   - per-post eligibility (which posts contribute views to a campaign)
 *   - campaign-level aggregation that can never double-count
 *
 * Design rules (from the Stage 9 spec):
 *   - Platform view counts are CUMULATIVE. Repeated observations of the same
 *     post must never be added together: 100 → 150 contributes 150, not 250.
 *   - A later LOWER provider response is not evidence that real views
 *     disappeared; it is a provider anomaly. The previously established
 *     high-water mark is preserved and the observation is flagged REVIEW.
 *   - Nothing is invented: no extrapolation, no estimation, no thresholds
 *     beyond "the number is a non-negative finite integer".
 *   - These checks are NOT bot detection or fraud scoring. They only catch
 *     what can be objectively determined from trusted provider data.
 *
 * Kept free of "server-only", Prisma and Next.js so it is unit-testable in
 * isolation from the database and the network (same convention as
 * submission-rules.ts and verification/identity.ts).
 */

import type { Platform, PostStatus } from "@/generated/prisma/client";

// ---------------------------------------------------------------------------
// Integrity checks — neutral, deterministic, no fraud claims
// ---------------------------------------------------------------------------

/**
 * Machine-readable ids of the objective integrity checks. These are stable
 * identifiers, not human accusations; UI copy maps them to neutral language.
 */
export const INTEGRITY_CHECK_IDS = [
  /** A metric was negative — impossible for a cumulative counter. */
  "negative_metrics",
  /** A metric was not a finite integer — malformed provider payload. */
  "malformed_metrics",
  /** The cumulative view count decreased vs the established high-water mark. */
  "cumulative_view_decrease",
  /** An identical observation (same key) was already recorded — idempotent no-op. */
  "duplicate_observation",
  /** The post's author does not match the creator's connected account. */
  "ownership_mismatch",
  /** Ownership could not be established from the OAuth connection. */
  "missing_ownership",
] as const;

export type IntegrityCheckId = (typeof INTEGRITY_CHECK_IDS)[number];

/**
 * Neutral integrity statuses:
 *   - CLEAN    — metrics are structurally valid and consistent with previous
 *                cumulative observations.
 *   - REVIEW   — metrics are structurally valid but inconsistent with previous
 *                cumulative observations (e.g. a counter going down). A flag,
 *                not a verdict about anyone.
 *   - REJECTED — the observation is malformed or invalid (negative, NaN,
 *                Infinity, fractional or out-of-range metrics). Never a
 *                bot/fraud claim; it means the data cannot be trusted at all.
 */
export type IntegrityStatus = "CLEAN" | "REVIEW" | "REJECTED";

// ---------------------------------------------------------------------------
// Metric validation — the only "threshold" is mathematical validity
// ---------------------------------------------------------------------------

/**
 * Upper bound for a storable metric. CampaignPost metric columns are Prisma
 * `Int` (PostgreSQL INTEGER, signed 32-bit); a provider count beyond this
 * bound cannot be persisted and must be treated as malformed, never silently
 * clamped.
 */
export const MAX_METRIC_VALUE = 2_147_483_647;

/**
 * Validate that a metric is a legitimate counter value: a non-negative finite
 * integer within the storable 32-bit range. Verifier code coerces payloads
 * before reaching this layer, so a failure here means the provider returned
 * something malformed.
 */
export function isValidMetricValue(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_METRIC_VALUE
  );
}

export type VerifierReportedMetrics = {
  views: number;
  likes: number;
  comments: number;
  shares: number;
};

/**
 * Objectively check reported metrics. Returns every failed check id. This is
 * deliberately NOT fraud detection: it only rejects values that are
 * mathematically impossible for a cumulative platform counter.
 */
export function checkReportedMetrics(
  metrics: VerifierReportedMetrics,
): IntegrityCheckId[] {
  const failed: IntegrityCheckId[] = [];

  const values = [
    metrics.views,
    metrics.likes,
    metrics.comments,
    metrics.shares,
  ];

  if (values.some((value) => !isValidMetricValue(value))) {
    // Distinguish the two objective failure shapes for auditability:
    //  - negative_metrics: a finite integer below zero (an impossible count)
    //  - malformed_metrics: anything that is not a storable non-negative
    //    integer (NaN, ±Infinity, fractional, out of 32-bit range,
    //    non-numeric). A fractional negative (e.g. -0.5) is malformed, not a
    //    negative count.
    const hasNegative = values.some(
      (value) =>
        typeof value === "number" &&
        Number.isFinite(value) &&
        Number.isInteger(value) &&
        value < 0,
    );

    if (hasNegative) {
      failed.push("negative_metrics");
    }

    const hasMalformed = values.some(
      (value) =>
        !isValidMetricValue(value) &&
        !(
          typeof value === "number" &&
          Number.isFinite(value) &&
          Number.isInteger(value) &&
          value < 0
        ),
    );

    if (hasMalformed) {
      failed.push("malformed_metrics");
    }
  }

  return failed;
}

// ---------------------------------------------------------------------------
// High-water rule for cumulative views
// ---------------------------------------------------------------------------

/**
 * Compute the eligible (high-water) verified view count for a post.
 *
 * `current` is the freshly reported cumulative count from the verifier;
 * `previousHighWater` is the best value previously established. A decrease
 * never lowers the stored number — the provider anomaly is surfaced by the
 * `cumulative_view_decrease` check instead.
 *
 * Returns null when the metrics themselves are invalid: invalid input must
 * never produce an eligible number.
 */
export function computeHighWaterVerifiedViews(
  current: number,
  previousHighWater: number | null,
): { views: number | null; checks: IntegrityCheckId[] } {
  if (!isValidMetricValue(current)) {
    return {
      views: null,
      checks: [
        // A finite integer below zero is a negative count; every other
        // invalid shape (NaN, ±Infinity, fractional, out of range) is a
        // malformed payload.
        typeof current === "number" &&
        Number.isFinite(current) &&
        Number.isInteger(current) &&
        current < 0
          ? "negative_metrics"
          : "malformed_metrics",
      ],
    };
  }

  if (
    previousHighWater !== null &&
    isValidMetricValue(previousHighWater) &&
    current < previousHighWater
  ) {
    return { views: previousHighWater, checks: ["cumulative_view_decrease"] };
  }

  return { views: current, checks: [] };
}

// ---------------------------------------------------------------------------
// Per-post eligibility
// ---------------------------------------------------------------------------

/**
 * Minimal shape of a post the accounting functions evaluate. Everything comes
 * from database rows loaded by the service layer — never from client input.
 */
export type AccountedPost = {
  id: string;
  platform: Platform;
  status: PostStatus;
  verifiedViews: number;
  /** True when ownership was proven via the creator's OAuth connection. */
  ownershipEstablished: boolean;
  /** True when the creator's connected platform account does not own the post. */
  ownershipMismatch: boolean;
  /** True when the latest observation was flagged by an integrity check. */
  integrityFlagged: boolean;
};

/**
 * Decide whether a post is ELIGIBLE to contribute views to its campaign.
 *
 * Only VERIFIED posts with proven ownership contribute. Everything else
 * contributes zero:
 *   - REJECTED            → the existing rejection path (including mismatch)
 *   - SUBMITTED/VERIFYING → pending / retryable, no verdict yet
 *   - VERIFIED without established ownership → cannot happen through the
 *     verifier path, but is excluded here so a tampered row can never pay.
 */
export function isEligibleForVerifiedViews(
  post: Pick<
    AccountedPost,
    "status" | "ownershipEstablished" | "ownershipMismatch"
  >,
): boolean {
  if (post.status !== "VERIFIED") {
    return false;
  }

  if (post.ownershipMismatch || !post.ownershipEstablished) {
    return false;
  }

  return true;
}

/**
 * Verified-view accounting for a single post.
 *
 * - eligible: whether the post contributes views at all
 * - views:    the post's current/high-water verified view count (0 when not
 *             eligible) — the LATEST cumulative value, never a sum of
 *             repeated observations
 * - status:   CLEAN, or REVIEW when the post is eligible but its latest
 *             verification raised an objective provider anomaly
 */
export function accountPostVerifiedViews(post: AccountedPost): {
  eligible: boolean;
  views: number;
  status: IntegrityStatus;
} {
  if (!isEligibleForVerifiedViews(post)) {
    return { eligible: false, views: 0, status: "CLEAN" };
  }

  return {
    eligible: true,
    views: Math.max(0, post.verifiedViews),
    // REVIEW is informational only: it never removes already-verified views
    // and never rejects the creator — additional verification is required.
    status: post.integrityFlagged ? "REVIEW" : "CLEAN",
  };
}

// ---------------------------------------------------------------------------
// Campaign aggregation
// ---------------------------------------------------------------------------

export type CampaignVerifiedViewTotals = {
  /** Sum of every eligible post's high-water verified views. */
  totalVerifiedViews: number;
  /** Number of posts that contributed. */
  eligiblePostCount: number;
  /** Number of VERIFIED posts (eligible or not) — for display context. */
  verifiedPostCount: number;
  /** True when at least one contributing post raised an integrity REVIEW. */
  hasReviewFlag: boolean;
};

/**
 * Aggregate verified views for a campaign from its posts. Each eligible post
 * contributes its single current cumulative value, so repeated observations
 * are inherently never double-counted. A total of zero is honest output (no
 * eligible posts), not a fabricated number.
 */
export function aggregateCampaignVerifiedViews(
  posts: AccountedPost[],
): CampaignVerifiedViewTotals {
  let total = 0;
  let eligibleCount = 0;
  let verifiedCount = 0;
  let hasReview = false;

  for (const post of posts) {
    if (post.status === "VERIFIED") {
      verifiedCount += 1;
    }

    const accounted = accountPostVerifiedViews(post);

    if (accounted.eligible) {
      total += accounted.views;
      eligibleCount += 1;

      if (accounted.status === "REVIEW") {
        hasReview = true;
      }
    }
  }

  return {
    totalVerifiedViews: total,
    eligiblePostCount: eligibleCount,
    verifiedPostCount: verifiedCount,
    hasReviewFlag: hasReview,
  };
}

// ---------------------------------------------------------------------------
// Idempotency key
// ---------------------------------------------------------------------------

/**
 * Deterministic idempotency key for one verification observation.
 *
 * (postId, platformPostId, observedAt) uniquely identifies a measurement:
 * the same post measured by the platform at the same millisecond is the same
 * observation. A concurrent or retried run producing the same key loses the
 * unique-constraint race and is treated as an idempotent no-op.
 *
 * platformPostId may be null for posts the platform has not yet matched;
 * the literal "unmatched" keeps the key stable and collision-free.
 *
 * Uses a plain separator with hex-encoded timestamps — both components are
 * system-generated values (uuids, epoch millis), never user input, so no
 * separator-collision concern exists.
 */
export function buildObservationKey(
  postId: string,
  platformPostId: string | null,
  observedAt: Date,
): string {
  const postPart = platformPostId ?? "unmatched";

  return `${postId}:${postPart}:${observedAt.getTime().toString(16)}`;
}

// ---------------------------------------------------------------------------
// Observation evaluation — the decision layer above the primitives
// ---------------------------------------------------------------------------

/** What the verification orchestrator observed for one run. */
export type ObservationInput = {
  postId: string;
  platform: Platform;
  /** Cumulative platform-reported metrics for THIS run. */
  metrics: VerifierReportedMetrics;
  /** Views the verifier determined eligible for this run (pre-high-water). */
  verifiedViews: number;
  /** The post's previously stored verified views (high-water so far). */
  previousVerifiedViews: number;
  /** Post status this run concluded (only VERIFIED rows are ever recorded). */
  verificationResult: Extract<PostStatus, "VERIFIED">;
  /** Platform post id, when the platform resolved one. */
  platformPostId: string | null;
  /** When the platform data was fetched. */
  observedAt: Date;
  /** Additional objective checks detected by the caller (e.g. ownership history). */
  extraChecks?: IntegrityCheckId[];
};

/**
 * Compute the accounting outcome for one verification run WITHOUT touching
 * the database: validation, high-water resolution and integrity status.
 * Split from the write so the orchestrator can persist post + observation
 * atomically with exactly these values.
 */
export function evaluateObservation(
  input: ObservationInput,
): {
  ok: boolean;
  eligibleVerifiedViews: number;
  integrityStatus: IntegrityStatus;
  checks: IntegrityCheckId[];
  observationKey: string;
} {
  // Invalid provider payload: no eligible number may be derived from it.
  const highWater = computeHighWaterVerifiedViews(
    input.metrics.views,
    input.previousVerifiedViews,
  );

  // Metric sanity checks, high-water checks and caller-supplied signals are
  // deduped together so the audit trail lists each objective check exactly
  // once (e.g. a negative view count trips both the metric check and the
  // high-water guard — it must still be reported once).
  const checks = [
    ...new Set([
      ...checkReportedMetrics(input.metrics),
      ...highWater.checks,
      ...(input.extraChecks ?? []),
    ]),
  ];

  const hasHardFailure = checks.some(
    (check) => check === "negative_metrics" || check === "malformed_metrics",
  );

  const eligibleVerifiedViews = hasHardFailure
    ? // Fall back to the previously established high-water mark; an invalid
      // payload must never overwrite a legitimate number with garbage.
      Math.max(0, input.previousVerifiedViews)
    : (highWater.views ?? Math.max(0, input.previousVerifiedViews));

  // Neutral status mapping (Stage 9A):
  //   - malformed/invalid metrics (negative, NaN, Infinity, out of range)
  //     → REJECTED: the observation itself is invalid and no view count may
  //     be derived from it.
  //   - valid-but-inconsistent data (e.g. cumulative decrease) → REVIEW.
  //   - otherwise → CLEAN. Ownership mismatch REJECTED rows never reach this
  //   recorder — that gate returns before any VERIFIED-shaped write.
  const integrityStatus: IntegrityStatus = hasHardFailure
    ? "REJECTED"
    : checks.length > 0
      ? "REVIEW"
      : "CLEAN";

  return {
    ok: !hasHardFailure,
    eligibleVerifiedViews,
    integrityStatus,
    checks,
    observationKey: buildObservationKey(
      input.postId,
      input.platformPostId,
      input.observedAt,
    ),
  };
}
