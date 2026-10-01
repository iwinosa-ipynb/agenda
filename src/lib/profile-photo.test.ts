import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isAllowedProfilePhotoContentType,
  isVercelBlobUrl,
  isWithinProfilePhotoSize,
  PROFILE_PHOTO_ALLOWED_CONTENT_TYPES,
  PROFILE_PHOTO_MAX_BYTES,
} from "@/lib/profile-photo";

/**
 * Profile-photo upload rules (shared by the client uploader and the server
 * token route — the server is authoritative). These pin the acceptance
 * boundary so a bad type/size can never be stored.
 */

describe("isAllowedProfilePhotoContentType", () => {
  it("accepts JPEG, PNG and WebP", () => {
    assert.equal(isAllowedProfilePhotoContentType("image/jpeg"), true);
    assert.equal(isAllowedProfilePhotoContentType("image/png"), true);
    assert.equal(isAllowedProfilePhotoContentType("image/webp"), true);
  });

  it("is case- and whitespace-insensitive", () => {
    assert.equal(isAllowedProfilePhotoContentType("  IMAGE/PNG "), true);
  });

  it("rejects other and missing types", () => {
    for (const bad of [
      "image/gif",
      "image/svg+xml",
      "application/pdf",
      "text/html",
      "",
      null,
      undefined,
    ]) {
      assert.equal(isAllowedProfilePhotoContentType(bad), false);
    }
  });

  it("exposes exactly the three supported types", () => {
    assert.deepEqual([...PROFILE_PHOTO_ALLOWED_CONTENT_TYPES], [
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
  });
});

describe("isWithinProfilePhotoSize", () => {
  it("accepts sizes in (0, 4MB]", () => {
    assert.equal(isWithinProfilePhotoSize(1), true);
    assert.equal(isWithinProfilePhotoSize(PROFILE_PHOTO_MAX_BYTES), true);
  });

  it("rejects oversized, zero, negative and non-finite sizes", () => {
    assert.equal(isWithinProfilePhotoSize(PROFILE_PHOTO_MAX_BYTES + 1), false);
    assert.equal(isWithinProfilePhotoSize(0), false);
    assert.equal(isWithinProfilePhotoSize(-5), false);
    assert.equal(isWithinProfilePhotoSize(Number.NaN), false);
    assert.equal(isWithinProfilePhotoSize(Number.POSITIVE_INFINITY), false);
    assert.equal(isWithinProfilePhotoSize(null), false);
    assert.equal(isWithinProfilePhotoSize(undefined), false);
  });
});

describe("isVercelBlobUrl — delete-ownership guard", () => {
  it("accepts a public Vercel Blob URL", () => {
    assert.equal(
      isVercelBlobUrl("https://store123.public.blob.vercel-storage.com/a.jpg"),
      true,
    );
  });

  it("rejects external and non-https URLs", () => {
    assert.equal(isVercelBlobUrl("https://evil.example.com/a.jpg"), false);
    assert.equal(isVercelBlobUrl("http://x.public.blob.vercel-storage.com/a"), false);
    assert.equal(isVercelBlobUrl(""), false);
    assert.equal(isVercelBlobUrl(null), false);
    assert.equal(isVercelBlobUrl(undefined), false);
    assert.equal(isVercelBlobUrl("not a url"), false);
  });

  it("rejects a lookalike host that only contains the suffix", () => {
    assert.equal(
      isVercelBlobUrl(
        "https://evilpublic.blob.vercel-storage.com.attacker.com/a.jpg",
      ),
      false,
    );
  });
});
