import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  derivePkceChallenge,
  generateOAuthState,
  generatePkceVerifier,
  OAUTH_STATE_TTL_MS,
  safeEqualStrings,
  validateOAuthState,
} from "@/lib/oauth-flow";

describe("generateOAuthState", () => {
  it("produces <token>.<issuedAtMs> values", () => {
    const now = new Date("2026-09-22T00:00:00Z");
    const state = generateOAuthState(now);

    const dot = state.lastIndexOf(".");

    assert.ok(dot > 0);
    assert.equal(state.slice(dot + 1), String(now.getTime()));
    assert.ok(state.slice(0, dot).length >= 40); // 32 bytes → 43 base64url chars
  });

  it("is random: two calls never collide", () => {
    const a = generateOAuthState();
    const b = generateOAuthState();

    assert.notEqual(a, b);
  });
});

describe("validateOAuthState", () => {
  it("accepts the exact, fresh state", () => {
    const now = new Date("2026-09-22T00:00:00Z");
    const state = generateOAuthState(now);

    assert.equal(validateOAuthState(state, state, now), true);
  });

  it("rejects a missing or empty state on either side", () => {
    const state = generateOAuthState();

    assert.equal(validateOAuthState(null, state), false);
    assert.equal(validateOAuthState("", state), false);
    assert.equal(validateOAuthState(state, null), false);
    assert.equal(validateOAuthState(state, ""), false);
    assert.equal(validateOAuthState(null, null), false);
  });

  it("rejects a foreign state (CSRF)", () => {
    const state = generateOAuthState();
    const attacker = generateOAuthState();

    assert.equal(validateOAuthState(attacker, state), false);
  });

  it("rejects an expired state beyond the TTL", () => {
    const issued = new Date("2026-09-22T00:00:00Z");
    const state = generateOAuthState(issued);
    const after = new Date(issued.getTime() + OAUTH_STATE_TTL_MS + 1);

    assert.equal(validateOAuthState(state, state, after), false);
  });

  it("accepts a state within the TTL", () => {
    const issued = new Date("2026-09-22T00:00:00Z");
    const state = generateOAuthState(issued);
    const justBefore = new Date(issued.getTime() + OAUTH_STATE_TTL_MS - 1000);

    assert.equal(validateOAuthState(state, state, justBefore), true);
  });

  it("rejects a state with a tampered token but valid timestamp", () => {
    const now = new Date();
    const state = generateOAuthState(now);
    const dot = state.lastIndexOf(".");
    const tampered = `AAAA${state.slice(4, dot)}.${state.slice(dot + 1)}`;

    assert.equal(validateOAuthState(tampered, state, now), false);
  });

  it("rejects a future-issued state (clock attack)", () => {
    const now = new Date("2026-09-22T00:00:00Z");
    const future = new Date(now.getTime() + 60_000);
    const state = generateOAuthState(future);

    assert.equal(validateOAuthState(state, state, now), false);
  });

  it("rejects malformed expected values", () => {
    assert.equal(validateOAuthState("x", "no-dot-here"), false);
    assert.equal(validateOAuthState("x", ".12345"), false);
    assert.equal(validateOAuthState("x", "token."), false);
    assert.equal(validateOAuthState("x", "token.notanumber"), false);
  });
});

describe("PKCE", () => {
  it("verifier is 43 base64url chars and random", () => {
    const a = generatePkceVerifier();
    const b = generatePkceVerifier();

    assert.equal(a.length, 43);
    assert.match(a, /^[\w-]+$/);
    assert.notEqual(a, b);
  });

  it("challenge is the S256 transformation of the verifier", () => {
    // RFC 7636 Appendix B test vector.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

    assert.equal(derivePkceChallenge(verifier), expected);
  });

  it("challenge is deterministic for the same verifier", () => {
    const verifier = generatePkceVerifier();

    assert.equal(derivePkceChallenge(verifier), derivePkceChallenge(verifier));
  });
});

describe("safeEqualStrings", () => {
  it("matches equal strings", () => {
    assert.equal(safeEqualStrings("abc", "abc"), true);
  });

  it("rejects different strings and lengths", () => {
    assert.equal(safeEqualStrings("abc", "abd"), false);
    assert.equal(safeEqualStrings("abc", "abcd"), false);
    assert.equal(safeEqualStrings("", ""), true);
  });
});
