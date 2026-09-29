import { VERIFICATION_TOKEN_BYTES } from "@/lib/verification-token";

/**
 * Password-reset token primitives.
 *
 * Same security properties as the Stage 10 verification tokens, with a
 * shorter lifetime because a live reset token is a direct account-takeover
 * capability:
 *  - 32 random bytes (256 bits) from the OS CSPRNG per token.
 *  - The raw token NEVER touches the database or logs: only sha256(token)
 *    is persisted. Lookups are a single indexed query on the hash.
 *  - Expiry is absolute (compared against now), independent of status.
 *  - Reuses the verification token's entropy/TTL constants so the entropy
 *    policy and hashing format stay defined in exactly one place.
 */

/** Reset links stay valid for 30 minutes (verification links get 1 hour). */
export const PASSWORD_RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

/** Same entropy policy as verification tokens (32 bytes, base64url). */
export const PASSWORD_RESET_TOKEN_BYTES = VERIFICATION_TOKEN_BYTES;

/**
 * Rate limiting mirrors the verification resend policy: at most one email
 * per 60s and 5 per user per rolling 24h. These gate a real email send.
 */
export const RESEND_MIN_INTERVAL_MS = 60 * 1000;
export const RESEND_MAX_PER_DAY = 5;

const RESEND_WINDOW_MS = 24 * 60 * 60 * 1000;

export {
  generateVerificationToken as generatePasswordResetToken,
  hashVerificationToken as hashPasswordResetToken,
  verificationExpiry as passwordResetExpiry,
} from "@/lib/verification-token";

/** Absolute expiry for a reset challenge issued at `issuedAt`. */
export function passwordResetExpiryFrom(issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + PASSWORD_RESET_TOKEN_TTL_MS);
}

/** True when the reset challenge's absolute expiry has passed. */
export function isPasswordResetExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}

/**
 * Rate-limit decision for a reset request. Pure so tests can pin the exact
 * boundaries without a clock. Same shape as the verification resend limiter
 * (1/min, 5/day), reusing the pure decision function.
 */
export function evaluatePasswordResetRateLimit(
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

export { RESEND_WINDOW_MS };
