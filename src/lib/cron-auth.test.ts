import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isAuthorizedCronRequest } from "@/lib/cron-auth";

/**
 * Unit tests for the machine-to-machine cron authorization. The endpoint
 * fails closed: no configured secret means every external trigger is refused,
 * regardless of what the request sends.
 */

const SECRET = "test-cron-secret-value";

describe("isAuthorizedCronRequest", () => {
  it("accepts a valid Bearer token", () => {
    const ok = isAuthorizedCronRequest(`Bearer ${SECRET}`, SECRET);

    assert.equal(ok, true);
  });

  it("accepts the Bearer scheme case-insensitively", () => {
    assert.equal(isAuthorizedCronRequest(`bearer ${SECRET}`, SECRET), true);
    assert.equal(isAuthorizedCronRequest(`BEARER ${SECRET}`, SECRET), true);
  });

  it("rejects a missing Authorization header", () => {
    assert.equal(isAuthorizedCronRequest(null, SECRET), false);
  });

  it("rejects an empty Authorization header", () => {
    assert.equal(isAuthorizedCronRequest("", SECRET), false);
  });

  it("rejects a malformed Authorization header (no Bearer scheme)", () => {
    assert.equal(isAuthorizedCronRequest(SECRET, SECRET), false);
    assert.equal(isAuthorizedCronRequest(`Token ${SECRET}`, SECRET), false);
    assert.equal(isAuthorizedCronRequest("Basic dXNlcjpwYXNz", SECRET), false);
  });

  it("rejects a wrong token", () => {
    assert.equal(isAuthorizedCronRequest("Bearer not-the-secret", SECRET), false);
  });

  it("rejects a token that is a prefix of the secret", () => {
    assert.equal(isAuthorizedCronRequest("Bearer test-cron-secret", SECRET), false);
  });  it("rejects bearer values with extra token content", () => {
    assert.equal(
      isAuthorizedCronRequest(`Bearer ${SECRET} extra`, SECRET),
      false,
    );
    assert.equal(isAuthorizedCronRequest(`${SECRET} `, SECRET), false);
  });

  it("tolerates whitespace around the scheme without accepting a different token", () => {
    // RFC 7235 allows 1*SP between the scheme and the token; the header is
    // trimmed and the token itself is still compared exactly and timing-safely,
    // so whitespace never lets a wrong token through.
    assert.equal(
      isAuthorizedCronRequest(` Bearer ${SECRET} `,
        SECRET),
      true,
    );
    assert.equal(isAuthorizedCronRequest(`Bearer  ${SECRET}`, SECRET), true);
  });

  it("fails closed when CRON_SECRET is unset", () => {
    assert.equal(isAuthorizedCronRequest(`Bearer ${SECRET}`, undefined), false);
    assert.equal(isAuthorizedCronRequest(`Bearer ${SECRET}`, ""), false);
    assert.equal(isAuthorizedCronRequest("Bearer anything", undefined), false);
    assert.equal(isAuthorizedCronRequest(null, undefined), false);
  });

  it("rejects when the request token matches an empty configured secret", () => {
    // An empty server secret must never authorize an empty Bearer value.
    assert.equal(isAuthorizedCronRequest("Bearer ", ""), false);
  });
});
