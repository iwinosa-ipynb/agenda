import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildObservationKey,
  evaluateObservation,
  type ObservationInput,
} from "@/services/verified-views-accounting";

/**
 * Tests for the observation evaluation logic — the database-free decision
 * layer used by the verified-views service. The pure accounting primitives
 * have their own test file; these cover the decision glue: integrity status
 * mapping, invalid-payload fallback and the deterministic observation key.
 *
 * No database and no live X/TikTok credentials are required.
 */

function input(overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    postId: "post-1",
    platform: "TIKTOK",
    metrics: { views: 100, likes: 10, comments: 2, shares: 1 },
    verifiedViews: 100,
    previousVerifiedViews: 0,
    verificationResult: "VERIFIED",
    platformPostId: "video-9",
    observedAt: new Date("2026-09-21T10:00:00.000Z"),
    ...overrides,
  };
}

describe("evaluateObservation — first verification", () => {
  it("records the first verified observation cleanly", () => {
    const result = evaluateObservation(input());

    assert.equal(result.ok, true);
    assert.equal(result.eligibleVerifiedViews, 100);
    assert.equal(result.integrityStatus, "CLEAN");
    assert.deepEqual(result.checks, []);
    assert.equal(
      result.observationKey,
      buildObservationKey(
        "post-1",
        "video-9",
        new Date("2026-09-21T10:00:00.000Z"),
      ),
    );
  });
});

describe("evaluateObservation — high-water behavior", () => {
  it("100 → 150 results in 150 eligible views", () => {
    const result = evaluateObservation(
      input({ metrics: { views: 150, likes: 12, comments: 3, shares: 2 }, previousVerifiedViews: 100 }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.eligibleVerifiedViews, 150);
    assert.equal(result.integrityStatus, "CLEAN");
  });

  it("100 → 150 → 130 preserves the 150 high-water and flags REVIEW", () => {
    const result = evaluateObservation(
      input({ metrics: { views: 130, likes: 12, comments: 3, shares: 2 }, previousVerifiedViews: 150 }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.eligibleVerifiedViews, 150);
    assert.equal(result.integrityStatus, "REVIEW");
    assert.deepEqual(result.checks, ["cumulative_view_decrease"]);
  });

  it("keeps the same count when the provider repeats itself", () => {
    const result = evaluateObservation(input({ previousVerifiedViews: 100 }));

    assert.equal(result.ok, true);
    assert.equal(result.eligibleVerifiedViews, 100);
    assert.equal(result.integrityStatus, "CLEAN");
  });
});

describe("evaluateObservation — invalid provider payloads", () => {
  it("rejects negative metrics as REJECTED and falls back to the previous high-water", () => {
    const result = evaluateObservation(
      input({ metrics: { views: -10, likes: 0, comments: 0, shares: 0 }, previousVerifiedViews: 150 }),
    );

    assert.equal(result.ok, false);
    // Never invents a new number and never drops below the established mark.
    assert.equal(result.eligibleVerifiedViews, 150);
    // A malformed observation is REJECTED — the data cannot be trusted at
    // all. This is a data-validity verdict, not a fraud claim.
    assert.equal(result.integrityStatus, "REJECTED");
    assert.ok(result.checks.includes("negative_metrics"));
  });

  it("rejects non-finite metrics as REJECTED and falls back to the previous high-water", () => {
    const result = evaluateObservation(
      input({
        metrics: {
          views: Number.POSITIVE_INFINITY,
          likes: 0,
          comments: 0,
          shares: 0,
        },
        previousVerifiedViews: 40,
      }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.eligibleVerifiedViews, 40);
    assert.equal(result.integrityStatus, "REJECTED");
    assert.ok(result.checks.includes("malformed_metrics"));
  });

  it("with no previous high-water, an invalid payload yields zero eligible views", () => {
    const result = evaluateObservation(
      input({ metrics: { views: -1, likes: 0, comments: 0, shares: 0 } }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.eligibleVerifiedViews, 0);
  });

  it("does not double-report the same integrity check", () => {
    const result = evaluateObservation(
      input({ metrics: { views: -5, likes: 0, comments: 0, shares: 0 } }),
    );

    assert.equal(result.checks.filter((c) => c === "negative_metrics").length, 1);
  });
});

describe("evaluateObservation — extra integrity signals", () => {
  it("maps extra checks to REVIEW without touching the view count", () => {
    const result = evaluateObservation(
      input({ extraChecks: ["missing_ownership"] }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.eligibleVerifiedViews, 100);
    assert.equal(result.integrityStatus, "REVIEW");
    assert.deepEqual(result.checks, ["missing_ownership"]);
  });

  it("deduplicates overlapping extra checks", () => {
    const result = evaluateObservation(
      input({ extraChecks: ["missing_ownership", "missing_ownership"] }),
    );

    assert.deepEqual(result.checks, ["missing_ownership"]);
  });
});

describe("evaluateObservation — idempotency key", () => {
  it("produces the same key for the same measurement (duplicate no-op)", () => {
    const at = new Date("2026-09-21T10:00:00.000Z");

    const a = evaluateObservation(input({ observedAt: at }));
    const b = evaluateObservation(input({ observedAt: at }));

    assert.equal(a.observationKey, b.observationKey);
  });

  it("produces a different key for a later observation of the same post", () => {
    const a = evaluateObservation(
      input({ observedAt: new Date("2026-09-21T10:00:00.000Z") }),
    );
    const b = evaluateObservation(
      input({ observedAt: new Date("2026-09-21T10:05:00.000Z") }),
    );

    assert.notEqual(a.observationKey, b.observationKey);
  });
});
