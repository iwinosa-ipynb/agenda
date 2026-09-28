import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyOpportunityMatch } from "@/lib/opportunity-matching";

/**
 * Pure unit tests for the V1 relevance rules.
 *
 * The pinned contract:
 *   - matching is BROADER than eligibility — missing/weak signals (location
 *     unknown, audience below the campaign minimum) never suppress a match;
 *   - followerCount and budget are signals, never gates;
 *   - the only rejection is "creator has no account on the campaign's
 *     platform" — the participation anchor.
 */
describe("opportunity matching — relevance rules", () => {
  const BASE_CREATOR = {
    category: "FASHION" as const,
    location: "Lagos, Nigeria",
    state: "Lagos",
    country: "Nigeria",
    followerCount: 12_000,
    platforms: ["TIKTOK" as const],
  };

  const BASE_CAMPAIGN = {
    platform: "TIKTOK" as const,
    category: "FASHION" as const,
    targetLocation: "Lagos",
    minimumFollowers: 10_000,
  };

  it("matches on platform + category + location with all reasons", () => {
    const result = classifyOpportunityMatch(BASE_CREATOR, BASE_CAMPAIGN);

    assert.equal(result.matched, true);
    assert.deepEqual(result.reasons, [
      "platform_match",
      "category_match",
      "location_match",
      "audience_size",
    ]);
  });

  it("matches when only the platform anchor holds (broader than eligibility)", () => {
    const result = classifyOpportunityMatch(
      {
        ...BASE_CREATOR,
        category: null,
        location: null,
        state: null,
        country: null,
        // Audience also below the campaign minimum: still a match.
        followerCount: 0,
      },
      BASE_CAMPAIGN,
    );

    assert.equal(result.matched, true);
    assert.deepEqual(result.reasons, ["platform_match"]);
  });

  it("does NOT match a creator with no account on the campaign platform", () => {
    const result = classifyOpportunityMatch(BASE_CREATOR, {
      ...BASE_CAMPAIGN,
      platform: "X",
    });

    assert.equal(result.matched, false);
    assert.deepEqual(result.reasons, []);
  });

  it("audience BELOW the campaign minimum is a weaker signal, never a rejection", () => {
    const result = classifyOpportunityMatch(
      { ...BASE_CREATOR, followerCount: 500 },
      BASE_CAMPAIGN,
    );

    assert.equal(result.matched, true);
    assert.deepEqual(result.reasons, [
      "platform_match",
      "category_match",
      "location_match",
    ]);
    assert.equal(result.reasons.includes("audience_size"), false);
  });

  it("an unknown location still matches (no location reason, no suppression)", () => {
    const result = classifyOpportunityMatch(
      { ...BASE_CREATOR, location: null, state: null, country: null },
      BASE_CAMPAIGN,
    );

    assert.equal(result.matched, true);
    assert.equal(result.reasons.includes("location_match"), false);
  });

  it("matches location across city/state/country free-text overlap", () => {
    const byState = classifyOpportunityMatch(
      { ...BASE_CREATOR, location: null },
      BASE_CAMPAIGN,
    );

    assert.equal(byState.reasons.includes("location_match"), true);

    const byCountry = classifyOpportunityMatch(
      {
        ...BASE_CREATOR,
        location: null,
        state: null,
        country: "Nigeria",
      },
      { ...BASE_CAMPAIGN, targetLocation: "Lagos, Nigeria" },
    );

    assert.equal(byCountry.reasons.includes("location_match"), true);
  });

  it("a category mismatch is a missing signal, not a rejection", () => {
    const result = classifyOpportunityMatch(
      { ...BASE_CREATOR, category: "TECH" },
      BASE_CAMPAIGN,
    );

    assert.equal(result.matched, true);
    assert.equal(result.reasons.includes("category_match"), false);
  });
});
