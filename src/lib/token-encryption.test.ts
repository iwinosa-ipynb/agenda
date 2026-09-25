import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  decryptToken,
  encryptToken,
  ENCRYPTION_KEY_ENV_VAR,
} from "@/lib/token-encryption";

const ORIGINAL_KEY = process.env[ENCRYPTION_KEY_ENV_VAR];

function setKey(value: string | undefined): void {
  if (value === undefined) {
    delete process.env[ENCRYPTION_KEY_ENV_VAR];
  } else {
    process.env[ENCRYPTION_KEY_ENV_VAR] = value;
  }
}

afterEach(() => {
  setKey(ORIGINAL_KEY);
});

describe("encryptToken / decryptToken", () => {
  it("round-trips a token with the same key", () => {
    setKey("a-test-key-with-enough-entropy-1234567890");

    const token = "act.example12345Example12345Example";
    const stored = encryptToken(token);

    assert.ok(stored);
    // Ciphertext must not contain the plaintext.
    assert.ok(!stored.includes(token));

    assert.equal(decryptToken(stored), token);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    setKey("another-test-key");

    const a = encryptToken("same-plaintext");
    const b = encryptToken("same-plaintext");

    assert.ok(a && b);
    assert.notEqual(a, b);
    assert.equal(decryptToken(a), "same-plaintext");
    assert.equal(decryptToken(b), "same-plaintext");
  });

  it("fails closed: no key → encrypt returns null (nothing stored)", () => {
    setKey(undefined);

    assert.equal(encryptToken("secret"), null);
  });

  it("fails closed: no key → decrypt returns null (no plaintext fallback)", () => {
    setKey("key-one");
    const stored = encryptToken("secret");

    setKey(undefined);

    assert.equal(decryptToken(stored), null);
  });

  it("rejects decryption with a different key (auth tag mismatch)", () => {
    setKey("key-one");
    const stored = encryptToken("secret");

    setKey("key-two");

    assert.equal(decryptToken(stored), null);
  });

  it("rejects tampered ciphertext", () => {
    setKey("integrity-key");

    const stored = encryptToken("secret") as string;
    const bytes = Buffer.from(stored, "base64");
    // Flip a bit deep in the ciphertext region (past IV + auth tag).
    bytes[bytes.length - 1] ^= 0x01;
    const tampered = bytes.toString("base64");

    assert.equal(decryptToken(tampered), null);
  });

  it("rejects truncated and malformed values without throwing", () => {
    setKey("any-key");

    assert.equal(decryptToken(""), null);
    assert.equal(decryptToken("not-base64!!!"), null);
    assert.equal(decryptToken(Buffer.from("short").toString("base64")), null);
    assert.equal(decryptToken(null), null);
    assert.equal(decryptToken(undefined), null);
  });
});
