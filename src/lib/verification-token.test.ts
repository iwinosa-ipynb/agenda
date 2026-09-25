import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RESEND_MAX_PER_DAY,
  RESEND_MIN_INTERVAL_MS,
  VERIFICATION_TOKEN_BYTES,
  VERIFICATION_TOKEN_TTL_MS,
  evaluateResendRateLimit,
  generateVerificationToken,
  hashVerificationToken,
  isVerificationExpired,
  verificationExpiry,
  verificationTokenHashesMatch,
} from "@/lib/verification-token";

describe("verification token primitives", () => {
  describe("generateVerificationToken", () => {
    it("produces base64url tokens from 32 random bytes", () => {
      const token = generateVerificationToken();

      // 32 bytes → 43 base64url chars, no padding, URL-safe alphabet.
      assert.equal(token.length, 43);
      assert.match(token, /^[A-Za-z0-9_-]+$/);
      // 43 base64 chars carry ≥ 256 bits of entropy (6*43 = 258 bits).
      assert.ok((token.length * 6) / 8 >= VERIFICATION_TOKEN_BYTES);
    });

    it("never generates the same token twice", () => {
      const seen = new Set<string>();

      for (let i = 0; i < 1000; i += 1) {
        seen.add(generateVerificationToken());
      }

      assert.equal(seen.size, 1000);
    });
  });

  describe("hashVerificationToken", () => {
    it("is deterministic SHA-256 hex", () => {
      const a = hashVerificationToken("token-value");
      const b = hashVerificationToken("token-value");

      assert.equal(a, b);
      assert.equal(a.length, 64);
      assert.match(a, /^[0-9a-f]{64}$/);
    });

    it("differs for different tokens", () => {
      assert.notEqual(
        hashVerificationToken("token-one"),
        hashVerificationToken("token-two"),
      );
    });

    it("never equals the raw token (raw token is not stored)", () => {
      const token = generateVerificationToken();

      assert.notEqual(hashVerificationToken(token), token);
    });
  });

  describe("verificationTokenHashesMatch", () => {
    it("matches identical digests and rejects different ones", () => {
      const digest = hashVerificationToken("token-value");

      assert.equal(verificationTokenHashesMatch(digest, digest), true);
      assert.equal(
        verificationTokenHashesMatch(digest, hashVerificationToken("other")),
        false,
      );
    });

    it("rejects different-length inputs without throwing", () => {
      assert.equal(verificationTokenHashesMatch("ab", "abc"), false);
      assert.equal(verificationTokenHashesMatch("", ""), true);
    });
  });

  describe("expiry", () => {
    it("expires exactly one hour after issuance", () => {
      const issuedAt = new Date("2026-01-01T00:00:00.000Z");
      const expiresAt = verificationExpiry(issuedAt);

      assert.equal(expiresAt.getTime() - issuedAt.getTime(), VERIFICATION_TOKEN_TTL_MS);

      // Just before expiry: valid. At expiry: expired. After: expired.
      assert.equal(
        isVerificationExpired(
          expiresAt,
          new Date(issuedAt.getTime() + VERIFICATION_TOKEN_TTL_MS - 1),
        ),
        false,
      );
      assert.equal(
        isVerificationExpired(expiresAt, expiresAt),
        true,
      );
      assert.equal(
        isVerificationExpired(
          expiresAt,
          new Date(expiresAt.getTime() + 1),
        ),
        true,
      );
    });
  });

  describe("evaluateResendRateLimit", () => {
    const now = new Date("2026-06-01T12:00:00.000Z");

    it("allows the first send (no history)", () => {
      assert.deepEqual(evaluateResendRateLimit(now, null, 0), { allowed: true });
    });

    it("blocks a resend inside the minimum interval", () => {
      const lastSentAt = new Date(now.getTime() - RESEND_MIN_INTERVAL_MS + 1000);

      assert.deepEqual(evaluateResendRateLimit(now, lastSentAt, 1), {
        allowed: false,
        reason: "min_interval",
      });
    });

    it("allows a resend exactly at the minimum interval boundary", () => {
      const lastSentAt = new Date(now.getTime() - RESEND_MIN_INTERVAL_MS);

      assert.deepEqual(evaluateResendRateLimit(now, lastSentAt, 1), {
        allowed: true,
      });
    });

    it("blocks at the daily cap", () => {
      assert.deepEqual(
        evaluateResendRateLimit(now, null, RESEND_MAX_PER_DAY),
        { allowed: false, reason: "daily_limit" },
      );
    });

    it("allows one below the daily cap", () => {
      assert.deepEqual(
        evaluateResendRateLimit(now, null, RESEND_MAX_PER_DAY - 1),
        { allowed: true },
      );
    });

    it("blocks when both limits are hit (interval check runs first)", () => {
      const lastSentAt = new Date(now.getTime() - 1000);

      assert.deepEqual(
        evaluateResendRateLimit(now, lastSentAt, RESEND_MAX_PER_DAY),
        { allowed: false, reason: "min_interval" },
      );
    });
  });
});
