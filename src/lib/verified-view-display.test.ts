import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatVerifiedMetric,
  getVerificationDisplayState,
  getLastVerifiedLabel,
  getVerifiedViewsNote,
  hasVerifiedMetrics,
  INTEGRITY_LABELS,
  INTEGRITY_NOTES,
  VERIFICATION_STATE_LABELS,
} from "@/lib/verified-view-display";

/**
 * Stage 9C tests — verified-view display formatting. Pure logic only: no
 * database, no live X/TikTok APIs (same convention as the Stage 9A
 * accounting tests).
 */

describe("getVerificationDisplayState", () => {
  it("maps every PostStatus to a clear display state", () => {
    assert.equal(getVerificationDisplayState("SUBMITTED"), "AWAITING");
    assert.equal(getVerificationDisplayState("VERIFYING"), "PENDING");
    assert.equal(getVerificationDisplayState("VERIFIED"), "VERIFIED");
    assert.equal(getVerificationDisplayState("REJECTED"), "REJECTED");
  });
});

describe("VERIFICATION_STATE_LABELS", () => {
  it("shows SUBMITTED as awaiting verification, not as zero metrics", () => {
    assert.equal(VERIFICATION_STATE_LABELS.AWAITING, "Awaiting verification");
    assert.equal(VERIFICATION_STATE_LABELS.PENDING, "Verifying");
    assert.equal(VERIFICATION_STATE_LABELS.VERIFIED, "Verified");
    assert.equal(VERIFICATION_STATE_LABELS.REJECTED, "Rejected");
  });
});

describe("hasVerifiedMetrics / formatVerifiedMetric", () => {
  it("shows real metrics only for VERIFIED posts", () => {
    assert.equal(hasVerifiedMetrics("VERIFIED"), true);
    assert.equal(hasVerifiedMetrics("SUBMITTED"), false);
    assert.equal(hasVerifiedMetrics("VERIFYING"), false);
    assert.equal(hasVerifiedMetrics("REJECTED"), false);
  });

  it("never renders zero for unavailable verification data", () => {
    // A stored 0 for a non-verified post must display as "—", not "0":
    // unavailable data must not look like a verified count.
    assert.equal(formatVerifiedMetric("SUBMITTED", 0), "—");
    assert.equal(formatVerifiedMetric("VERIFYING", 0), "—");
    assert.equal(formatVerifiedMetric("REJECTED", 0), "—");
    assert.equal(formatVerifiedMetric("SUBMITTED", 1250), "—");
  });

  it("formats the stored count for VERIFIED posts", () => {
    assert.equal(formatVerifiedMetric("VERIFIED", 0), "0");
    assert.equal(formatVerifiedMetric("VERIFIED", 1250), "1.3K");
  });
});

describe("getLastVerifiedLabel", () => {
  it("formats the timestamp when a sync exists", () => {
    const label = getLastVerifiedLabel(
      new Date("2026-09-21T10:00:00.000Z"),
      "VERIFIED",
    );

    // The exact rendering is locale/timezone-dependent, so assert the shape:
    // a non-empty formatted date, distinct from every placeholder.
    assert.ok(label.length > 0);
    assert.notEqual(label, "Awaiting verification");
    assert.notEqual(label, "Never");
    // It contains the stored moment's day/month/year, whatever the locale.
    assert.match(label, /2026/);
  });

  it("uses state-aware placeholders instead of fabricated dates", () => {
    assert.equal(getLastVerifiedLabel(null, "SUBMITTED"), "Awaiting verification");
    assert.equal(getLastVerifiedLabel(null, "VERIFYING"), "Awaiting verification");
    assert.equal(getLastVerifiedLabel(null, "VERIFIED"), "Never");
    assert.equal(getLastVerifiedLabel(null, "REJECTED"), "Never");
  });
});

describe("getVerifiedViewsNote", () => {
  it("explains pending states without implying any metric exists", () => {
    const awaiting = getVerifiedViewsNote("SUBMITTED") ?? "";
    assert.match(awaiting, /Awaiting verification/i);
    assert.doesNotMatch(awaiting, /0 views/i);

    const pending = getVerifiedViewsNote("VERIFYING") ?? "";
    assert.match(pending, /running/i);

    const rejected = getVerifiedViewsNote("REJECTED") ?? "";
    assert.match(rejected, /did not meet/i);
    assert.match(rejected, /no verified views exist/i);
  });

  it("returns no note for VERIFIED posts", () => {
    assert.equal(getVerifiedViewsNote("VERIFIED"), null);
  });
});

describe("integrity presentation (Task 9: REVIEW is REVIEW)", () => {
  it("labels REVIEW literally and neutrally", () => {
    assert.equal(INTEGRITY_LABELS.REVIEW, "REVIEW");
    assert.equal(INTEGRITY_LABELS.CLEAN, "Clean");
  });

  it("never describes REVIEW as fraud or bot activity", () => {
    const note = INTEGRITY_NOTES.REVIEW ?? "";

    // Literal, neutral flag wording:
    assert.match(note, /additional verification required/i);
    // Not accusations — these words must not appear in any integrity copy:
    assert.doesNotMatch(note, /fraud/i);
    assert.doesNotMatch(note, /bot/i);
    assert.doesNotMatch(note, /fake/i);
    assert.doesNotMatch(note, /cheat/i);
    assert.doesNotMatch(note, /suspicious/i);
  });

  it("has no note for CLEAN posts", () => {
    assert.equal(INTEGRITY_NOTES.CLEAN, null);
  });
});
