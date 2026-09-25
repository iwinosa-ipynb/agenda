import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  matchTikTokOwnership,
  matchXAuthorship,
} from "@/services/verification/identity";

describe("matchXAuthorship", () => {
  it("matches when the post author id equals the connected platformUserId", () => {
    const result = matchXAuthorship("1234567890123456789", "1234567890123456789");

    assert.equal(result.result, "MATCHED");
  });

  it("flags a mismatch when the post belongs to someone else", () => {
    const result = matchXAuthorship("9999999999999999999", "1234567890123456789");

    assert.equal(result.result, "MISMATCH");
  });

  it("cannot establish ownership when the API returned no author id", () => {
    const result = matchXAuthorship(null, "1234567890123456789");

    assert.equal(result.result, "CANNOT_ESTABLISH");
  });

  it("cannot establish ownership when the creator has no connected account", () => {
    const result = matchXAuthorship("1234567890123456789", null);

    assert.equal(result.result, "CANNOT_ESTABLISH");
  });

  it("treats empty strings as missing values", () => {
    assert.equal(matchXAuthorship("", "123").result, "CANNOT_ESTABLISH");
    assert.equal(matchXAuthorship("123", "  ").result, "CANNOT_ESTABLISH");
  });

  it("trims surrounding whitespace before comparing", () => {
    assert.equal(matchXAuthorship(" 123 ", "123").result, "MATCHED");
  });
});

describe("matchTikTokOwnership", () => {
  it("matches when the video owner open_id equals the connected platformUserId", () => {
    const result = matchTikTokOwnership(
      "afd97af1-b87b-48b9-ac98-410aghda5344",
      "afd97af1-b87b-48b9-ac98-410aghda5344",
    );

    assert.equal(result.result, "MATCHED");
  });

  it("flags a mismatch for a foreign open_id", () => {
    const result = matchTikTokOwnership(
      "other-user-open-id",
      "afd97af1-b87b-48b9-ac98-410aghda5344",
    );

    assert.equal(result.result, "MISMATCH");
  });

  it("cannot establish ownership when the video owner id is unavailable", () => {
    assert.equal(matchTikTokOwnership(null, "open-id-1").result, "CANNOT_ESTABLISH");
  });

  it("cannot establish ownership when the creator is not connected", () => {
    assert.equal(matchTikTokOwnership("open-id-1", null).result, "CANNOT_ESTABLISH");
  });
});
