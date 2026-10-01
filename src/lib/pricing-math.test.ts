import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildGuidanceRange,
  getQuoteGuidanceWarning,
  MIN_GUIDANCE_SAMPLE,
  percentile,
} from "@/lib/pricing-math";

/**
 * Stage 12 — pure pricing-math tests.
 *
 * The pinned contract:
 *   - ranges are built ONLY from real history; below the minimum distinct
 *     sample count the result is INSUFFICIENT_DATA with no numbers at all;
 *   - one agreement dominating the sample is not a market signal;
 *   - the published band is the p25–p75 window widened ±10% so it reads as
 *     guidance rather than a claim of precision;
 *   - the low-quote helper is ADVISORY ONLY: it warns for a meaningfully low
 *     quote and never constrains, clamps or rewrites the amount.
 */

describe("buildGuidanceRange — real-history ranges", () => {
  it("returns INSUFFICIENT_DATA below MIN_GUIDANCE_SAMPLE (no numbers)", () => {
    const tooFew = Array.from(
      { length: MIN_GUIDANCE_SAMPLE - 1 },
      (_, i) => (i + 1) * 10_000,
    );

    const range = buildGuidanceRange(tooFew);

    assert.equal(range.dataAvailability, "INSUFFICIENT_DATA");
    assert.equal(range.suggestedMin, null);
    assert.equal(range.suggestedMax, null);
    assert.equal(range.sampleSize, MIN_GUIDANCE_SAMPLE - 1);
  });

  it("returns AVAILABLE with a widened p25–p75 band at the sample boundary", () => {
    const samples = [100_000, 120_000, 140_000, 160_000, 180_000];

    const range = buildGuidanceRange(samples);

    assert.equal(range.dataAvailability, "AVAILABLE");
    assert.equal(range.sampleSize, 5);
    assert.equal(range.suggestedMin, "108000.00");
    assert.equal(range.suggestedMax, "176000.00");
  });

  it("widens the raw p25/p75 percentiles by ±10%", () => {
    const samples = [100, 200, 300, 400, 500];

    const range = buildGuidanceRange(samples);

    // Raw p25 = 200, raw p75 = 400.
    assert.equal(percentile(samples, 0.25), 200);
    assert.equal(percentile(samples, 0.75), 400);
    // Widened down 10% / up 10%: 180 / 440.
    assert.equal(range.suggestedMin, "180.00");
    assert.equal(range.suggestedMax, "440.00");
  });

  it("refuses a sample dominated by a single agreement", () => {
    // 1000 is more than 80% of the 1004 total — a lone outlier, not a market.
    const samples = [1, 1, 1, 1, 1000];

    const range = buildGuidanceRange(samples);

    assert.equal(range.dataAvailability, "INSUFFICIENT_DATA");
    assert.equal(range.suggestedMin, null);
    assert.equal(range.sampleSize, 5);
  });

  it("still yields a valid band for identical (degenerate) values", () => {
    const samples = [100_000, 100_000, 100_000, 100_000, 100_000];

    const range = buildGuidanceRange(samples);

    assert.equal(range.dataAvailability, "AVAILABLE");
    assert.equal(range.suggestedMin, "90000.00");
    assert.equal(range.suggestedMax, "110000.00");
    assert.ok(Number(range.suggestedMin) < Number(range.suggestedMax));
  });

  it("clamps a collapsing band to a positive-width range", () => {
    // At ₦1 the ±10% widening rounds back to the same value; the degenerate
    // guard must still return a strictly positive-width band.
    const range = buildGuidanceRange([1, 1, 1, 1, 1]);

    assert.equal(range.dataAvailability, "AVAILABLE");
    assert.equal(range.suggestedMin, "1.00");
    assert.equal(range.suggestedMax, "1.20");
  });
});

describe("getQuoteGuidanceWarning — soft, advisory low-quote nudge", () => {
  const available = {
    dataAvailability: "AVAILABLE" as const,
    suggestedMin: "100000.00",
    suggestedMax: "200000.00",
  };

  it("warns for a quote meaningfully below the suggested minimum", () => {
    // 50,000 < 100,000 × 0.9.
    const warning = getQuoteGuidanceWarning("50000", available);

    assert.equal(typeof warning, "string");
    assert.ok((warning as string).length > 0);
  });

  it("does NOT warn at exactly the suggested minimum", () => {
    assert.equal(getQuoteGuidanceWarning("100000", available), null);
  });

  it("does NOT warn just below the minimum when the gap is only rounding", () => {
    // 99,000 is below 100,000 but within the 10% tolerance.
    assert.equal(getQuoteGuidanceWarning("99000", available), null);
  });

  it("does NOT warn at or above the range", () => {
    assert.equal(getQuoteGuidanceWarning("100000", available), null);
    assert.equal(getQuoteGuidanceWarning("250000", available), null);
  });

  it("does NOT warn for an empty or invalid quote", () => {
    assert.equal(getQuoteGuidanceWarning("", available), null);
    assert.equal(getQuoteGuidanceWarning("   ", available), null);
    assert.equal(getQuoteGuidanceWarning(undefined, available), null);
    assert.equal(getQuoteGuidanceWarning("abc", available), null);
    assert.equal(getQuoteGuidanceWarning("0", available), null);
  });

  it("does NOT warn when data is INSUFFICIENT_DATA", () => {
    assert.equal(
      getQuoteGuidanceWarning("1", {
        dataAvailability: "INSUFFICIENT_DATA",
        suggestedMin: null,
      }),
      null,
    );
  });

  it("does NOT warn when the guidance numbers are missing", () => {
    assert.equal(
      getQuoteGuidanceWarning("1", {
        dataAvailability: "AVAILABLE",
        suggestedMin: null,
      }),
      null,
    );
    assert.equal(getQuoteGuidanceWarning("1", null), null);
    assert.equal(getQuoteGuidanceWarning("1", undefined), null);
  });

  it("accepts a numeric quote", () => {
    assert.equal(typeof getQuoteGuidanceWarning(50_000, available), "string");
    assert.equal(getQuoteGuidanceWarning(100_000, available), null);
  });
});
