/**
 * Creator profile-photo upload rules (pure, no I/O).
 *
 * Kept free of server-only / SDK imports so both the client uploader and the
 * server upload route can share the SAME constraints, and so the rules are
 * directly unit-testable. The server is always authoritative: the client
 * checks are for UX only.
 */

/** Image types a creator may upload as a profile photo. */
export const PROFILE_PHOTO_ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type ProfilePhotoContentType =
  (typeof PROFILE_PHOTO_ALLOWED_CONTENT_TYPES)[number];

/** Hard maximum upload size (4 MB), enforced server-side by the upload route. */
export const PROFILE_PHOTO_MAX_BYTES = 4 * 1024 * 1024;

/** Normalize then test a MIME type against the allow-list. */
export function isAllowedProfilePhotoContentType(
  contentType: string | null | undefined,
): contentType is ProfilePhotoContentType {
  if (typeof contentType !== "string") {
    return false;
  }

  return (PROFILE_PHOTO_ALLOWED_CONTENT_TYPES as readonly string[]).includes(
    contentType.trim().toLowerCase(),
  );
}

/** True when the byte size is a positive value within the limit. */
export function isWithinProfilePhotoSize(
  bytes: number | null | undefined,
): boolean {
  return (
    typeof bytes === "number" &&
    Number.isFinite(bytes) &&
    bytes > 0 &&
    bytes <= PROFILE_PHOTO_MAX_BYTES
  );
}

/**
 * True only for URLs that belong to a Vercel Blob *public* store. Used before
 * deleting a superseded profile image so the cleanup path can never be used to
 * delete an arbitrary external URL. The suffix check is anchored on a dot so a
 * lookalike host (e.g. `evilpublic.blob.vercel-storage.com.attacker.com`) is
 * rejected.
 */
export function isVercelBlobUrl(url: string | null | undefined): boolean {
  if (typeof url !== "string" || url.trim() === "") {
    return false;
  }

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") {
    return false;
  }

  return parsed.hostname.endsWith(".public.blob.vercel-storage.com");
}
