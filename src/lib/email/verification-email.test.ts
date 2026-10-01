import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildVerificationUrl } from "@/lib/email/verification-email";

/**
 * Regression tests for the verification link builder.
 *
 * The bug this pins: the builder used to emit `/verify-email`, but the page
 * is mounted at `/auth/verify-email` (no route exists at `/verify-email`), so
 * every email link 404'd before the token could ever be consumed. The
 * password-reset builder already used the correct `/auth/...` prefix.
 */

describe("buildVerificationUrl", () => {
  const BASE = "https://agenda-kappa-mauve.vercel.app";

  it("targets the real /auth/verify-email route, never a bare /verify-email", () => {
    const url = buildVerificationUrl("token-value", BASE);
    const parsed = new URL(url);

    assert.equal(parsed.pathname, "/auth/verify-email");
    // The exact regression: the path must NOT be the route-less `/verify-email`.
    assert.notEqual(parsed.pathname, "/verify-email");
  });

  it("URL-encodes the token", () => {
    const token = "a b+c/d?=&";

    const url = buildVerificationUrl(token, BASE);

    assert.equal(new URL(url).searchParams.get("token"), token);
    assert.ok(url.includes(encodeURIComponent(token)));
  });

  it("respects the configured base URL and strips trailing slashes", () => {
    assert.equal(
      buildVerificationUrl("tok", BASE),
      `${BASE}/auth/verify-email?token=tok`,
    );
    assert.equal(
      buildVerificationUrl("tok", "https://example.com/"),
      "https://example.com/auth/verify-email?token=tok",
    );
  });

  it("falls back to localhost when no base is configured", () => {
    assert.equal(
      buildVerificationUrl("tok", ""),
      "http://localhost:3000/auth/verify-email?token=tok",
    );
  });
});
