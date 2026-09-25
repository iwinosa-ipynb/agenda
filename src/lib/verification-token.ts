import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Email-verification token primitives (Stage 10).
 *
 * Security properties:
 *  - 32 random bytes (256 bits) of entropy from the OS CSPRNG per token.
 *  - The raw token NEVER touches the database or logs: only `sha256(token)`
 *    is persisted. The DB is indexed on the hash, not the secret.
 *  - Comparison is timing-safe. The hash is deterministic so lookups are a
 *    single indexed query — a DB leak therefore cannot resurrect tokens.
 *  - Expiry is absolute (compared against now), independent of status, so an
 *    expired token is rejected even if cleanup has not run yet.
 *
 * Kept dependency-light and side-effect-free (like src/lib/cron-auth.ts) so
 * the whole security surface can be unit tested without a database.
 */

/** 32 bytes = 256 bits of entropy, URL-safe base64url (43 chars, no padding). */
export const VERIFICATION_TOKEN_BYTES = 32;

/** Verification links stay valid for one hour. */
export const VERIFICATION_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Resend throttling: at most one email per 60s and 5 per user per rolling
 * 24h. Deliberately conservative — these gate a real email send.
 */
export const RESEND_MIN_INTERVAL_MS = 60 * 1000;
export const RESEND_MAX_PER_DAY = 5;

function base64url(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Generate a fresh high-entropy verification token (not yet hashed). */
export function generateVerificationToken(): string {
  return base64url(randomBytes(VERIFICATION_TOKEN_BYTES));
}

/** Deterministic SHA-256, hex-encoded. This is what the database stores. */
export function hashVerificationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Timing-safe equality for two same-length hex digests. Length mismatch
 * returns false immediately (structure leak only, which reveals nothing).
 */
export function verificationTokenHashesMatch(
  a: string,
  b: string,
): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");

  if (bufA.length !== bufB.length) {
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

/** Absolute expiry for a challenge issued at `issuedAt`. */
export function verificationExpiry(issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + VERIFICATION_TOKEN_TTL_MS);
}

/** True when the challenge's absolute expiry has passed. */
export function isVerificationExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}

/**
 * Rate-limit decision for a resend request. Pure so tests can pin the exact
 * boundaries without a clock.
 */
export function evaluateResendRateLimit(
  now: Date,
  lastSentAt: Date | null,
  sentCount24h: number,
): { allowed: true } | { allowed: false; reason: "min_interval" | "daily_limit" } {
  if (lastSentAt) {
    const elapsed = now.getTime() - lastSentAt.getTime();

    if (elapsed < RESEND_MIN_INTERVAL_MS) {
      return { allowed: false, reason: "min_interval" };
    }
  }

  if (sentCount24h >= RESEND_MAX_PER_DAY) {
    return { allowed: false, reason: "daily_limit" };
  }

  return { allowed: true };
}
