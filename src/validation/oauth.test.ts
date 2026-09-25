import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseOAuthCallbackParams } from "@/validation/oauth";

function params(entries: Record<string, string>): URLSearchParams {
  return new URLSearchParams(entries);
}

describe("parseOAuthCallbackParams", () => {
  it("accepts a well-formed code + state callback", () => {
    const result = parseOAuthCallbackParams(
      params({
        code: "a-valid-authorization-code",
        state: "abcDEF-_123.1726963200000",
      }),
    );

    assert.ok(result.kind === "OK");
    assert.ok(result.kind === "OK" && result.code.length > 0);
    assert.ok(result.kind === "OK" && result.state.length > 0);
  });

  it("rejects a missing code (INVALID, never forwarded to the exchange)", () => {
    const result = parseOAuthCallbackParams(
      params({ state: "abcDEF-_123.1726963200000" }),
    );

    assert.equal(result.kind, "INVALID");
  });

  it("rejects an empty code", () => {
    const result = parseOAuthCallbackParams(
      params({ code: "", state: "abcDEF-_123.1726963200000" }),
    );

    assert.equal(result.kind, "INVALID");
  });

  it("rejects a missing state", () => {
    const result = parseOAuthCallbackParams(params({ code: "some-code" }));

    assert.equal(result.kind, "INVALID");
  });

  it("rejects a malformed state shape (no timestamp suffix)", () => {
    const result = parseOAuthCallbackParams(
      params({ code: "some-code", state: "just-a-token-no-dot" }),
    );

    assert.equal(result.kind, "INVALID");
  });

  it("rejects control-character smuggling in state", () => {
    const result = parseOAuthCallbackParams(
      params({ code: "some-code", state: "tok%0dHeader.1726963200000" }),
    );

    assert.equal(result.kind, "INVALID");
  });

  it("recognizes a denied authorization (provider error param)", () => {
    const result = parseOAuthCallbackParams(
      params({
        error: "access_denied",
        error_description: "The user has denied your application access.",
        state: "abcDEF-_123.1726963200000",
      }),
    );

    assert.ok(result.kind === "DENIED");
    assert.ok(result.kind === "DENIED" && result.error === "access_denied");
    // The raw provider description is captured but the parser never marks a
    // denial as OK, so it can never reach the token exchange.
    assert.notEqual(result.kind, "OK");
  });

  it("treats an oversized provider error as invalid", () => {
    const result = parseOAuthCallbackParams(
      params({ error: "x".repeat(101) }),
    );

    assert.equal(result.kind, "INVALID");
  });
});
