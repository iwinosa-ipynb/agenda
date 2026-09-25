import { createHash, randomBytes } from "node:crypto";

/**
 * Pure, dependency-light OAuth security primitives shared by the X and TikTok
 * connection flows:
 *
 *  - CSRF `state` generation + constant-time validation
 *  - PKCE code verifier / S256 challenge generation (RFC 7636)
 *  - base64url helpers
 *
 * No network calls, no "server-only", no framework imports — unit tests run
 * these directly. Callers (route handlers) are responsible for persisting the
 * state/verifier server-side (cookie) and validating on callback; this module
 * only provides the deterministic cryptographic mechanics so the security
 * logic can be tested without a Next.js runtime.
 *
 * The `state` value embeds a random token AND the creation timestamp
 * (`<random>.<issuedMs>`), letting the callback both compare the token
 * (constant time) and reject states older than the TTL — a replayed state
 * from an abandoned flow is refused.
 */

/** OAuth states live for at most 10 minutes. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** RFC 7636 §4.1: verifier length 43–128 chars from the unreserved set. */
const PKCE_VERIFIER_BYTES = 32; // → 43 base64url chars

/** base64url without padding (RFC 7636 §4.2 "plain" alphabet). */
export function toBase64Url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/** Generate a fresh OAuth state: `<random base64url>.<issuedAtMs>`. */
export function generateOAuthState(now: Date = new Date()): string {
  const token = toBase64Url(randomBytes(32));

  return `${token}.${now.getTime()}`;
}

/**
 * Validate a state value against the expected one.
 *
 * Rules (all must hold):
 *  - both values are non-empty strings
 *  - the issued-at suffix parses and is not older than the TTL
 *  - the random token matches the expected value in constant time
 *
 * Returns true only for an exact, fresh match. A missing/invalid/foreign/
 * expired state is always false — this is the CSRF and replay guard.
 */
export function validateOAuthState(
  received: string | null | undefined,
  expected: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!received || !expected) {
    return false;
  }

  const dotIndex = expected.lastIndexOf(".");

  if (dotIndex <= 0 || dotIndex === expected.length - 1) {
    return false;
  }

  const expectedToken = expected.slice(0, dotIndex);
  const issuedAt = Number(expected.slice(dotIndex + 1));

  if (!Number.isFinite(issuedAt)) {
    return false;
  }

  if (now.getTime() - issuedAt > OAUTH_STATE_TTL_MS || issuedAt > now.getTime()) {
    return false;
  }

  const receivedDot = received.lastIndexOf(".");

  if (receivedDot <= 0) {
    return false;
  }

  const receivedToken = received.slice(0, receivedDot);

  return safeEqualStrings(receivedToken, expectedToken);
}

/**
 * Constant-time string equality (compare lengths first, then XOR-fold).
 * Deliberately implemented without node:crypto here so this module stays
 * framework-free; the security property that matters is that comparison time
 * does not depend on where the first differing byte is.
 */
export function safeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let mismatch = 0;

  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return mismatch === 0;
}

/** PKCE code verifier: 43 base64url chars from 32 random bytes. */
export function generatePkceVerifier(): string {
  return toBase64Url(randomBytes(PKCE_VERIFIER_BYTES));
}

/** PKCE S256 challenge: base64url(SHA256(verifier)). */
export function derivePkceChallenge(verifier: string): string {
  return toBase64Url(createHash("sha256").update(verifier, "ascii").digest());
}
