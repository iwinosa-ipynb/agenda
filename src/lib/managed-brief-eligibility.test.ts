import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isManagedBriefSourcingAccountEligible } from "@/lib/managed-brief-eligibility";

/**
 * Pure unit tests for the single shared definition of "this SocialAccount can
 * back a managed-brief candidate": connectable platform (TIKTOK/X) AND
 * OAuth-connected (platformUserId present). This mirrors the marketplace
 * application gate (applyToCampaign's `platformUserId: { not: null }` on the
 * campaign's platform) — pinning anything else would create a campaign the
 * selected creator can never apply to.
 */
describe("managed brief sourcing account eligibility", () => {
  it("accepts a connected TIKTOK account", () => {
    assert.equal(
      isManagedBriefSourcingAccountEligible({
        platform: "TIKTOK",
        platformUserId: "tt-123",
      }),
      true,
    );
  });

  it("accepts a connected X account", () => {
    assert.equal(
      isManagedBriefSourcingAccountEligible({
        platform: "X",
        platformUserId: "x-987",
      }),
      true,
    );
  });

  it("rejects a TIKTOK claimed-only account (platformUserId null)", () => {
    assert.equal(
      isManagedBriefSourcingAccountEligible({
        platform: "TIKTOK",
        platformUserId: null,
      }),
      false,
    );
  });

  it("rejects an X claimed-only account (platformUserId null)", () => {
    assert.equal(
      isManagedBriefSourcingAccountEligible({
        platform: "X",
        platformUserId: null,
      }),
      false,
    );
  });

  it("rejects an unsupported platform even when connected", () => {
    for (const platform of ["INSTAGRAM", "YOUTUBE", "FACEBOOK"]) {
      assert.equal(
        isManagedBriefSourcingAccountEligible({
          platform,
          platformUserId: "some-id",
        }),
        false,
        platform,
      );
    }
  });

  it("rejects a missing platformUserId field (undefined legacy row)", () => {
    assert.equal(
      isManagedBriefSourcingAccountEligible({
        platform: "TIKTOK",
        platformUserId: undefined as unknown as string | null,
      }),
      false,
    );
  });

  it("rejects a blank platformUserId (defensive trim)", () => {
    assert.equal(
      isManagedBriefSourcingAccountEligible({
        platform: "X",
        platformUserId: "   ",
      }),
      false,
    );
  });

  it("rejects an empty/unknown platform string", () => {
    assert.equal(
      isManagedBriefSourcingAccountEligible({
        platform: "",
        platformUserId: "id-1",
      }),
      false,
    );
  });
});
