/**
 * Pure platform-identity matching for post verification (Stage 8).
 *
 * The question these functions answer is: "does the platform-side author of
 * this submitted post belong to the Agenda creator who submitted it?"
 *
 * Rules:
 *  - A match requires BOTH a post author id from the platform API AND a
 *    stored platformUserId from the creator's OAuth connection. Missing
 *    either side means ownership CANNOT be established — never a rejection,
 *    never a fake verification.
 *  - Comparison is exact on normalized (trimmed, case-normalized where the
 *    platform treats ids as case-sensitive=false) strings.
 *  - Kept free of "server-only", Prisma and Next.js so it is unit-testable.
 */

export type IdentityMatch =
  | { result: "MATCHED" }
  | { result: "MISMATCH" }
  | { result: "CANNOT_ESTABLISH"; reason: string };

/** Normalize a platform user id for comparison. Ids are opaque strings. */
function normalizeId(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Match an X post's author_id against the creator's connected X account.
 *
 * X user ids are numeric strings, case has no meaning, but we compare
 * verbatim-after-trim: the ids come from two different API responses
 * (tweet lookup author_id vs OAuth users/me id) and X guarantees both are
 * the canonical numeric id.
 */
export function matchXAuthorship(
  postAuthorId: string | null | undefined,
  connectedPlatformUserId: string | null | undefined,
): IdentityMatch {
  const authorId = normalizeId(postAuthorId);
  const connected = normalizeId(connectedPlatformUserId);

  if (!authorId) {
    return {
      result: "CANNOT_ESTABLISH",
      reason: "The X API did not return the post's author id.",
    };
  }

  if (!connected) {
    return {
      result: "CANNOT_ESTABLISH",
      reason: "The creator has no connected X account to compare against.",
    };
  }

  return authorId === connected
    ? { result: "MATCHED" }
    : { result: "MISMATCH" };
}

/**
 * Match a TikTok video's ownership against the creator's connected account.
 *
 * TikTok's /v2/video/query/ only returns videos owned by the token's user —
 * the video being returned at all is already a strong ownership signal. We
 * still require the explicit id match against the stored open_id so the
 * proof does not depend on that endpoint behavior staying constant.
 */
export function matchTikTokOwnership(
  videoOwnerOpenId: string | null | undefined,
  connectedPlatformUserId: string | null | undefined,
): IdentityMatch {
  const ownerId = normalizeId(videoOwnerOpenId);
  const connected = normalizeId(connectedPlatformUserId);

  if (!ownerId) {
    return {
      result: "CANNOT_ESTABLISH",
      reason: "The TikTok API did not expose the video owner's id.",
    };
  }

  if (!connected) {
    return {
      result: "CANNOT_ESTABLISH",
      reason: "The creator has no connected TikTok account to compare against.",
    };
  }

  return ownerId === connected
    ? { result: "MATCHED" }
    : { result: "MISMATCH" };
}
