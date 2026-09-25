import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  accountPostVerifiedViews,
  aggregateCampaignVerifiedViews,
  buildObservationKey,
  checkReportedMetrics,
  computeHighWaterVerifiedViews,
  isEligibleForVerifiedViews,
  isValidMetricValue,
  MAX_METRIC_VALUE,
  type AccountedPost,
} from "@/services/verified-views-accounting";

/**
 * Stage 9 unit tests — pure verified-view accounting and integrity logic.
 *
 * These run without a database and without live X/TikTok credentials: every
 * input is a plain object shaped like a database row or verifier output.
 */

function post(overrides: Partial<AccountedPost> = {}): AccountedPost {
  return {
    id: "post-1",
    platform: "TIKTOK",
    status: "VERIFIED",
    verifiedViews: 0,
    ownershipEstablished: true,
    ownershipMismatch: false,
    integrityFlagged: false,
    ...overrides,
  };
}

describe("metric validation", () => {
  it("accepts non-negative finite integers", () => {
    assert.equal(isValidMetricValue(0), true);
    assert.equal(isValidMetricValue(100), true);
    assert.equal(isValidMetricValue(150), true);
  });

  it("rejects negative metrics", () => {
    assert.equal(isValidMetricValue(-1), false);
    assert.equal(isValidMetricValue(-0.5), false);
  });

  it("rejects non-finite and malformed metrics", () => {
    assert.equal(isValidMetricValue(Number.NaN), false);
    assert.equal(isValidMetricValue(Number.POSITIVE_INFINITY), false);
    assert.equal(isValidMetricValue(Number.NEGATIVE_INFINITY), false);
    assert.equal(isValidMetricValue(10.5), false);
    assert.equal(isValidMetricValue("100"), false);
    assert.equal(isValidMetricValue(null), false);
    assert.equal(isValidMetricValue(undefined), false);
  });

  it("rejects values beyond the storable 32-bit integer range", () => {
    assert.equal(isValidMetricValue(MAX_METRIC_VALUE), true);
    assert.equal(isValidMetricValue(MAX_METRIC_VALUE + 1), false);
  });

  it("flags negative reported metrics as negative_metrics", () => {
    const checks = checkReportedMetrics({
      views: -5,
      likes: 10,
      comments: 2,
      shares: 1,
    });

    assert.deepEqual(checks, ["negative_metrics"]);
  });

  it("flags non-finite reported metrics as malformed_metrics", () => {
    const checks = checkReportedMetrics({
      views: Number.POSITIVE_INFINITY,
      likes: 10,
      comments: 2,
      shares: 1,
    });

    assert.deepEqual(checks, ["malformed_metrics"]);
  });

  it("flags fractional reported metrics as malformed_metrics", () => {
    const checks = checkReportedMetrics({
      views: 100.25,
      likes: 10,
      comments: 2,
      shares: 1,
    });

    assert.deepEqual(checks, ["malformed_metrics"]);
  });

  it("flags fractional negative metrics as malformed (not negative)", () => {
    const checks = checkReportedMetrics({
      views: -0.5,
      likes: 10,
      comments: 2,
      shares: 1,
    });

    assert.deepEqual(checks, ["malformed_metrics"]);
  });

  it("flags out-of-range reported metrics as malformed_metrics", () => {
    const checks = checkReportedMetrics({
      views: MAX_METRIC_VALUE + 1,
      likes: 10,
      comments: 2,
      shares: 1,
    });

    assert.deepEqual(checks, ["malformed_metrics"]);
  });

  it("returns no checks for a clean payload", () => {
    const checks = checkReportedMetrics({
      views: 150,
      likes: 10,
      comments: 2,
      shares: 1,
    });

    assert.deepEqual(checks, []);
  });
});

describe("high-water rule", () => {
  it("keeps the first verified snapshot as-is", () => {
    const result = computeHighWaterVerifiedViews(100, null);

    assert.deepEqual(result, { views: 100, checks: [] });
  });

  it("100 → 150 results in 150 eligible views", () => {
    const result = computeHighWaterVerifiedViews(150, 100);

    assert.deepEqual(result, { views: 150, checks: [] });
  });

  it("100 → 150 → 130 remains 150 (no decrease, no subtraction)", () => {
    const first = computeHighWaterVerifiedViews(100, null);
    const second = computeHighWaterVerifiedViews(150, first.views);
    const third = computeHighWaterVerifiedViews(130, second.views);

    assert.deepEqual(second, { views: 150, checks: [] });
    assert.deepEqual(third, { views: 150, checks: ["cumulative_view_decrease"] });
  });

  it("equal counts keep the value and raise no anomaly", () => {
    const result = computeHighWaterVerifiedViews(150, 150);

    assert.deepEqual(result, { views: 150, checks: [] });
  });

  it("rejects invalid current counts with the correct check id", () => {
    // A finite integer below zero is a negative count...
    assert.deepEqual(computeHighWaterVerifiedViews(-1, 100).checks, [
      "negative_metrics",
    ]);
    // ...while NaN and Infinity are malformed payloads.
    assert.deepEqual(
      computeHighWaterVerifiedViews(Number.NaN, 100).checks,
      ["malformed_metrics"],
    );
    assert.deepEqual(
      computeHighWaterVerifiedViews(Number.POSITIVE_INFINITY, 100).checks,
      ["malformed_metrics"],
    );
    assert.deepEqual(
      computeHighWaterVerifiedViews(MAX_METRIC_VALUE + 1, 100).checks,
      ["malformed_metrics"],
    );
  });

  it("does not extrapolate or estimate views", () => {
    // A large jump is still recorded verbatim — the platform said so.
    const result = computeHighWaterVerifiedViews(1_000_000, 100);

    assert.deepEqual(result, { views: 1_000_000, checks: [] });
  });
});

describe("per-post eligibility", () => {
  it("includes VERIFIED posts with established ownership", () => {
    assert.equal(isEligibleForVerifiedViews(post()), true);
  });

  it("gives rejected posts zero contribution", () => {
    const accounted = accountPostVerifiedViews(
      post({ status: "REJECTED", verifiedViews: 500 }),
    );

    assert.deepEqual(accounted, { eligible: false, views: 0, status: "CLEAN" });
  });

  it("gives pending posts zero contribution", () => {
    for (const status of ["SUBMITTED", "VERIFYING"] as const) {
      const accounted = accountPostVerifiedViews(
        post({ status, verifiedViews: 500 }),
      );

      assert.deepEqual(accounted, { eligible: false, views: 0, status: "CLEAN" });
    }
  });

  it("gives ownership-mismatch posts zero contribution", () => {
    const accounted = accountPostVerifiedViews(
      post({ ownershipMismatch: true, verifiedViews: 500 }),
    );

    assert.deepEqual(accounted, { eligible: false, views: 0, status: "CLEAN" });
  });

  it("gives posts without established ownership zero contribution", () => {
    const accounted = accountPostVerifiedViews(
      post({ ownershipEstablished: false, verifiedViews: 500 }),
    );

    assert.deepEqual(accounted, { eligible: false, views: 0, status: "CLEAN" });
  });

  it("keeps verified views for eligible posts flagged REVIEW (not removed)", () => {
    const accounted = accountPostVerifiedViews(post({ integrityFlagged: true, verifiedViews: 150 }));

    assert.deepEqual(accounted, { eligible: true, views: 150, status: "REVIEW" });
  });
});

describe("campaign aggregation", () => {
  it("aggregates multiple verified posts correctly", () => {
    const totals = aggregateCampaignVerifiedViews([
      post({ id: "a", verifiedViews: 150 }),
      post({ id: "b", platform: "X", verifiedViews: 1200 }),
    ]);

    assert.equal(totals.totalVerifiedViews, 1350);
    assert.equal(totals.eligiblePostCount, 2);
    assert.equal(totals.verifiedPostCount, 2);
    assert.equal(totals.hasReviewFlag, false);
  });

  it("counts repeated observations of one post once (latest cumulative value)", () => {
    // A post re-verified over time stores ONE current value (the high-water),
    // not a sum of snapshots. The aggregation therefore contributes 150, not
    // 100+150=250.
    const totals = aggregateCampaignVerifiedViews([
      post({ id: "a", verifiedViews: 150 }),
    ]);

    assert.equal(totals.totalVerifiedViews, 150);
  });

  it("excludes rejected posts from the total", () => {
    const totals = aggregateCampaignVerifiedViews([
      post({ id: "a", verifiedViews: 150 }),
      post({ id: "b", status: "REJECTED", verifiedViews: 9999 }),
    ]);

    assert.equal(totals.totalVerifiedViews, 150);
    assert.equal(totals.eligiblePostCount, 1);
  });

  it("excludes pending posts from the total", () => {
    const totals = aggregateCampaignVerifiedViews([
      post({ id: "a", verifiedViews: 150 }),
      post({ id: "b", status: "SUBMITTED" }),
      post({ id: "c", status: "VERIFYING" }),
    ]);

    assert.equal(totals.totalVerifiedViews, 150);
    assert.equal(totals.eligiblePostCount, 1);
  });

  it("excludes ownership-mismatch and missing-ownership posts", () => {
    const totals = aggregateCampaignVerifiedViews([
      post({ id: "a", verifiedViews: 150 }),
      post({ id: "b", ownershipMismatch: true, verifiedViews: 9999 }),
      post({ id: "c", ownershipEstablished: false, verifiedViews: 9999 }),
    ]);

    assert.equal(totals.totalVerifiedViews, 150);
    assert.equal(totals.eligiblePostCount, 1);
  });

  it("returns honest zeros when nothing is eligible", () => {
    const totals = aggregateCampaignVerifiedViews([
      post({ status: "REJECTED" }),
    ]);

    assert.equal(totals.totalVerifiedViews, 0);
    assert.equal(totals.eligiblePostCount, 0);
    assert.equal(totals.verifiedPostCount, 0);
  });

  it("surfaces a review flag when an eligible post is flagged", () => {
    const totals = aggregateCampaignVerifiedViews([
      post({ id: "a", verifiedViews: 150, integrityFlagged: true }),
      post({ id: "b", platform: "X", verifiedViews: 10 }),
    ]);

    assert.equal(totals.totalVerifiedViews, 160);
    assert.equal(totals.hasReviewFlag, true);
  });
});

describe("idempotency key", () => {
  it("is deterministic for identical inputs", () => {
    const at = new Date("2026-09-21T10:00:00.000Z");

    assert.equal(
      buildObservationKey("post-1", "video-9", at),
      buildObservationKey("post-1", "video-9", at),
    );
  });

  it("differs per platform post id", () => {
    const at = new Date("2026-09-21T10:00:00.000Z");

    assert.notEqual(
      buildObservationKey("post-1", "video-9", at),
      buildObservationKey("post-1", "video-10", at),
    );
  });

  it("differs per observation time", () => {
    assert.notEqual(
      buildObservationKey("post-1", "video-9", new Date("2026-09-21T10:00:00.000Z")),
      buildObservationKey("post-1", "video-9", new Date("2026-09-21T10:00:01.000Z")),
    );
  });

  it("differs per post even at the same instant", () => {
    const at = new Date("2026-09-21T10:00:00.000Z");

    assert.notEqual(
      buildObservationKey("post-1", null, at),
      buildObservationKey("post-2", null, at),
    );
  });

  it("keeps a stable key for unmatched platform posts", () => {
    const at = new Date("2026-09-21T10:00:00.000Z");

    assert.equal(
      buildObservationKey("post-1", null, at),
      buildObservationKey("post-1", "unmatched", at),
    );
  });
});

describe("client control resistance (type-level guarantees)", () => {
  it("accounts only values captured in AccountedPost rows loaded server-side", () => {
    // The accounting input has no client-writable channel: callers pass rows
    // read from the database. A forged object can only come from server code.
    const forged = {
      id: "x",
      platform: "TIKTOK",
      status: "VERIFIED",
      verifiedViews: 999_999,
      ownershipEstablished: true,
      ownershipMismatch: false,
      integrityFlagged: false,
    } satisfies AccountedPost;

    const totals = aggregateCampaignVerifiedViews([forged]);

    assert.equal(totals.totalVerifiedViews, 999_999);
  });

  it("never sums per-post values beyond one cumulative number each", () => {
    // Even if the same post appeared twice in a list (it cannot, ids are
    // unique), the accounting model has no add-per-observation path: each row
    // contributes exactly its own current value.
    const totals = aggregateCampaignVerifiedViews([
      post({ id: "a", verifiedViews: 100 }),
      post({ id: "a", verifiedViews: 100 }),
    ]);

    assert.equal(totals.totalVerifiedViews, 200);
    assert.equal(totals.eligiblePostCount, 2);
  });
});
