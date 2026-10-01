/**
 * Image upload rules for Vercel Blob client uploads (pure, no I/O).
 *
 * Shared by BOTH upload flows — creator profile photos and advertiser logos —
 * and by their client uploaders and server token routes, so every surface
 * enforces the SAME constraints. The server is always authoritative: the
 * client checks are for UX only.
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
 * Storage pathname prefixes per upload flow. The server token route only
 * issues tokens for its own prefix, so a CREATOR can never mint a token for
 * an advertiser-logo path (and vice versa).
 */
export const CREATOR_PHOTO_PREFIX = "profile-photos/";
export const ADVERTISER_LOGO_PREFIX = "advertiser-logos/";

/**
 * True when a client-requested blob pathname belongs to the given flow
 * prefix AND names an actual file (something after the prefix). Blocks path
 * traversal, foreign-prefix token minting, and bare-prefix pathnames.
 */
export function isAllowedUploadPathname(
  pathname: string | null | undefined,
  prefix: string,
): boolean {
  if (typeof pathname !== "string" || pathname.length <= prefix.length) {
    return false;
  }

  return pathname.startsWith(prefix) && !pathname.includes("..");
}

/**
 * True only for URLs that belong to a Vercel Blob *public* store. The suffix
 * check is anchored on a dot so a lookalike host (e.g.
 * `evilpublic.blob.vercel-storage.com.attacker.com`) is rejected.
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

/**
 * Ownership guard for a STORED image URL: it must be a Vercel Blob public URL
 * under the given flow's prefix. Used before deleting a superseded image and
 * before accepting a client-supplied URL, so one flow can never delete (or
 * claim) another flow's blobs. (The leading slash is stripped because Blob URL
 * pathnames are rooted, while token prefixes are not.)
 */
export function isOwnedUploadUrl(
  url: string | null | undefined,
  prefix: string,
): boolean {
  if (!isVercelBlobUrl(url)) {
    return false;
  }

  const pathname = new URL(url as string).pathname.replace(/^\/+/, "");

  return isAllowedUploadPathname(pathname, prefix);
}
