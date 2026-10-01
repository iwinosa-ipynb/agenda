import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ADVERTISER_LOGO_PREFIX,
  CREATOR_PHOTO_PREFIX,
  isAllowedProfilePhotoContentType,
  isAllowedUploadPathname,
  isOwnedUploadUrl,
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

describe("isAllowedUploadPathname — per-flow token scoping", () => {
  it("accepts paths under the flow's own prefix", () => {
    assert.equal(
      isAllowedUploadPathname(
        "profile-photos/abc-photo.png",
        CREATOR_PHOTO_PREFIX,
      ),
      true,
    );
    assert.equal(
      isAllowedUploadPathname(
        "advertiser-logos/abc-logo.png",
        ADVERTISER_LOGO_PREFIX,
      ),
      true,
    );
  });

  it("rejects a foreign flow's prefix (creator cannot mint logo tokens)", () => {
    assert.equal(
      isAllowedUploadPathname(
        "advertiser-logos/abc-logo.png",
        CREATOR_PHOTO_PREFIX,
      ),
      false,
    );
    assert.equal(
      isAllowedUploadPathname(
        "profile-photos/abc-photo.png",
        ADVERTISER_LOGO_PREFIX,
      ),
      false,
    );
  });

  it("rejects traversal, bare prefixes and empty values", () => {
    assert.equal(
      isAllowedUploadPathname("profile-photos/../../secret.png", CREATOR_PHOTO_PREFIX),
      false,
    );
    assert.equal(isAllowedUploadPathname("profile-photos/", CREATOR_PHOTO_PREFIX), false);
    assert.equal(isAllowedUploadPathname("", CREATOR_PHOTO_PREFIX), false);
    assert.equal(isAllowedUploadPathname(null, CREATOR_PHOTO_PREFIX), false);
    assert.equal(isAllowedUploadPathname(undefined, CREATOR_PHOTO_PREFIX), false);
  });
});

describe("isOwnedUploadUrl — ownership-scoped deletion", () => {
  it("accepts a blob URL under the owning flow's prefix", () => {
    assert.equal(
      isOwnedUploadUrl(
        "https://store123.public.blob.vercel-storage.com/advertiser-logos/x.png",
        ADVERTISER_LOGO_PREFIX,
      ),
      true,
    );
  });

  it("rejects a blob URL from another flow's prefix", () => {
    assert.equal(
      isOwnedUploadUrl(
        "https://store123.public.blob.vercel-storage.com/profile-photos/x.png",
        ADVERTISER_LOGO_PREFIX,
      ),
      false,
    );
  });

  it("rejects external URLs and non-blob values", () => {
    assert.equal(
      isOwnedUploadUrl("https://cdn.example.com/advertiser-logos/x.png", ADVERTISER_LOGO_PREFIX),
      false,
    );
    assert.equal(isOwnedUploadUrl(null, ADVERTISER_LOGO_PREFIX), false);
  });
});
