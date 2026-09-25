/**
 * Pure mapping/classification helpers for the official X and TikTok API
 * responses. Kept free of "server-only" and side effects so they can be unit
 * tested in isolation from the network-calling verifiers.
 */

export type PlatformPostMetricsInput = {
  platformPostId: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  fetchedAt: Date;
};

// ---------------------------------------------------------------------------
// X API v2 — GET /2/tweets/:id
// ---------------------------------------------------------------------------

export type XParsedMetrics = {
  retweet_count?: number;
  reply_count?: number;
  like_count?: number;
  quote_count?: number;
  bookmark_count?: number;
  impression_count?: number;
};

export type XPostData = {
  id?: string;
  author_id?: string;
  created_at?: string;
  public_metrics?: XParsedMetrics;
};

/** Map an X API HTTP status onto the shared failure taxonomy. */
export function classifyXHttpStatus(status: number): {
  kind: "PROVIDER_AUTH" | "POST_NOT_FOUND" | "PROVIDER_UNAVAILABLE";
  message: string;
} {
  if (status === 401 || status === 403) {
    return {
      kind: "PROVIDER_AUTH",
      message: "X rejected the API credentials for this request.",
    };
  }
  if (status === 404) {
    return { kind: "POST_NOT_FOUND", message: "X has no post with this ID." };
  }
  if (status === 429) {
    return {
      kind: "PROVIDER_UNAVAILABLE",
      message: "X API rate limit reached. Verification will retry later.",
    };
  }
  return {
    kind: "PROVIDER_UNAVAILABLE",
    message: `X API request failed with status ${status}.`,
  };
}

/**
 * Map X `public_metrics` into the verifier's metric contract. X has no "view"
 * concept in public data — `impression_count` is the official reported
 * equivalent. Missing metrics stay 0 per the PlatformPostMetrics convention;
 * nothing is estimated or invented.
 */
export function mapXPostToMetrics(
  post: XPostData,
): PlatformPostMetricsInput {
  const metrics = post.public_metrics ?? {};

  return {
    platformPostId: post.id as string,
    views: metrics.impression_count ?? 0,
    likes: metrics.like_count ?? 0,
    comments: metrics.reply_count ?? 0,
    shares: (metrics.retweet_count ?? 0) + (metrics.quote_count ?? 0),
    fetchedAt: post.created_at ? new Date(post.created_at) : new Date(),
  };
}

// ---------------------------------------------------------------------------
// TikTok Display API — POST /v2/video/query/
// ---------------------------------------------------------------------------

export type TikTokVideo = {
  id?: string;
  like_count?: number;
  comment_count?: number;
  share_count?: number;
  view_count?: number;
};

/**
 * Map a TikTok /v2/video/query/ video object into the verifier metric
 * contract. Every value comes verbatim from the API; a missing metric stays
 * 0 — nothing is estimated or invented.
 */
export function mapTikTokVideoToMetrics(
  video: TikTokVideo,
): PlatformPostMetricsInput {
  return {
    platformPostId: video.id as string,
    views: video.view_count ?? 0,
    likes: video.like_count ?? 0,
    comments: video.comment_count ?? 0,
    shares: video.share_count ?? 0,
    fetchedAt: new Date(),
  };
}

/** Documented token/permission error codes for /v2/video/query/. */
const TIKTOK_AUTH_ERROR_CODES = new Set([
  "invalid_access_token",
  "access_token_invalid",
  "access_token_expired",
  "scope_not_authorized",
  "permission_denied",
]);

/** Map a TikTok error code / HTTP status onto the shared failure taxonomy. */
export function classifyTikTokFailure(
  errorCode: string | undefined,
  httpStatus: number,
): { kind: "PROVIDER_AUTH" | "POST_NOT_FOUND" | "PROVIDER_UNAVAILABLE"; message: string } {
  if (errorCode !== undefined && TIKTOK_AUTH_ERROR_CODES.has(errorCode)) {
    return {
      kind: "PROVIDER_AUTH",
      message: "TikTok rejected the access token or its scopes.",
    };
  }

  if (httpStatus === 401 || httpStatus === 403) {
    return {
      kind: "PROVIDER_AUTH",
      message: "TikTok rejected the credentials for this request.",
    };
  }

  if (httpStatus === 404) {
    return { kind: "POST_NOT_FOUND", message: "TikTok has no video with this ID." };
  }

  if (httpStatus === 429) {
    return {
      kind: "PROVIDER_UNAVAILABLE",
      message: "TikTok API rate limit reached. Verification will retry later.",
    };
  }

  return {
    kind: "PROVIDER_UNAVAILABLE",
    message: `TikTok API request failed with status ${httpStatus}.`,
  };
}
