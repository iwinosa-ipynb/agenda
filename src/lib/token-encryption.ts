import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Token encryption at rest for OAuth credentials (TikTok user access /
 * refresh tokens).
 *
 * Design:
 * - AES-256-GCM (authenticated encryption). The auth tag is stored with the
 *   ciphertext; a tampered value fails authentication on decrypt and returns
 *   null instead of ever handing back corrupted plaintext.
 * - The key is derived with SHA-256 from the `SOCIAL_TOKEN_ENCRYPTION_KEY`
 *   environment variable (a 32-byte hex or arbitrary high-entropy string).
 *   Derived, not raw, so operators can pass a passphrase of any length.
 * - A fresh random 12-byte IV per encryption call — the same plaintext
 *   encrypts to a different ciphertext every time (no deterministic leak).
 * - Storage format: base64(iv(12) + tag(16) + ciphertext).
 * - Fails closed: with no key configured, encrypt returns null (callers must
 *   not persist plaintext) and decrypt returns null. No plaintext fallback
 *   path exists anywhere.
 *
 * Server-only: this module must never be imported from client code. It is
 * dependency-light (node:crypto only) so it can be unit tested without a
 * database or Next.js runtime.
 */

export const ENCRYPTION_KEY_ENV_VAR = "SOCIAL_TOKEN_ENCRYPTION_KEY";

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/** Resolve the raw 32-byte key material from the environment, or null. */
function resolveKeyMaterial(): Buffer | null {
  const raw = process.env[ENCRYPTION_KEY_ENV_VAR];

  if (!raw || raw.trim().length === 0) {
    return null;
  }

  return createHash("sha256").update(raw.trim(), "utf8").digest();
}

/**
 * Encrypt a token for storage. Returns null when no encryption key is
 * configured — the caller must then NOT store the token (fail closed).
 */
export function encryptToken(plaintext: string): string | null {
  const key = resolveKeyMaterial();

  if (!key) {
    return null;
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

/**
 * Decrypt a stored token. Returns null when the key is missing, the value is
 * malformed, or authentication fails (wrong key / tampered data). Never
 * throws for bad input — a null return is the caller's signal that the token
 * is unusable and the flow must degrade to the retryable/unconfigured path.
 */
export function decryptToken(stored: string | null | undefined): string | null {
  const key = resolveKeyMaterial();

  if (!key || !stored) {
    return null;
  }

  let packed: Buffer;

  try {
    packed = Buffer.from(stored, "base64");
  } catch {
    return null;
  }

  if (
    packed.length <= IV_LENGTH + AUTH_TAG_LENGTH ||
    !Number.isFinite(packed.length)
  ) {
    return null;
  }

  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong key, tampered ciphertext, or corrupted tag.
    return null;
  }
}

/**
 * Constant-time comparison for short public values (OAuth `state` cookies vs
 * query parameters). Not used for high-entropy secret comparison (the cron
 * secret has its own check) — this exists so state validation cannot be
 * short-circuited by timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");

  if (bufA.length !== bufB.length) {
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}
