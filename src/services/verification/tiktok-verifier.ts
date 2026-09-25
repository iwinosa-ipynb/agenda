import "server-only";

import type { Platform } from "@/types";

import {
  registerVerifier,
  VerificationFailureError,
  type PlatformPostMetrics,
  type PlatformVerifier,
  type ViewVerificationVerdict,
} from "@/services/verification";
import {
  classifyTikTokFailure,
  mapTikTokVideoToMetrics,
  type TikTokVideo,
} from "@/services/verification/metric-mapping";
import { parseTikTokVideoUrl } from "@/services/verification/url-parsing";

/**
 * TikTok PlatformVerifier — official TikTok APIs only.
 *
 * Endpoint:  POST https://open.tiktokapis.com/v2/video/query/
 * Scope:     video.list
 * Docs:      https://developers.tiktok.com/doc/tiktok-api-v2-video-query
 *
 * CRITICAL OAUTH PREREQUISITE (explicit, not faked):
 * The /v2/video/query/ endpoint requires a USER-CONTEXT access token
 * (`Authorization: Bearer act.…`) obtained through the TikTok OAuth flow
 * (Authorization Code, with the `video.list` scope granted by the creator).
 * An application client_key/client_secret alone CANNOT call this endpoint.
 *
 * The current project has NO TikTok OAuth flow: `SocialAccount` stores only a
 * claimed username/profileUrl (plus a never-populated platformUserId) and
 * there is no token storage or authorization redirect anywhere. Without a
 * creator-granted access token this verifier cannot legitimately retrieve any
 * metrics, so it fails clearly and safely (PROVIDER_AUTH) — it never fakes a
 * successful verification, never fabricates metrics, never marks VERIFIED.
 *
 * The API call itself is fully implemented below and will work unchanged the
 * moment a valid user access token can be supplied (see the Stage 6 report
 * for the exact missing prerequisite).
 */const TIKTOK_API_BASE = "https://open.tiktokapis.com";
const REQUEST_TIMEOUT_MS = 10_000;

const VIDEO_FIELDS = [
  "id",
  "like_count",
  "comment_count",
  "share_count",
  "view_count",
] as const;

// Shared response/classification helpers live in metric-mapping.ts so they
// stay unit-testable without importing "server-only" modules.

type TikTokQueryResponse = {
  data?: {
    videos?: TikTokVideo[];
  };
  error?: {
    code?: string;
    message?: string;
    log_id?: string;
  };
};

async function queryTikTokVideo(
  videoId: string,
  accessToken: string,
): Promise<TikTokVideo | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;

  try {
    response = await fetch(
      `${TIKTOK_API_BASE}/v2/video/query/?fields=${VIDEO_FIELDS.join(",")}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filters: { video_ids: [videoId] },
        }),
        signal: controller.signal,
        cache: "no-store",
      },
    );
  } catch {
    // Network/timeout errors are provider-side and retryable.
    throw new VerificationFailureError(
      "PROVIDER_UNAVAILABLE",
      "Could not reach the TikTok API. Verification will retry later.",
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const { kind, message } = classifyTikTokFailure(undefined, response.status);
    throw new VerificationFailureError(kind, message);
  }

  const payload = (await response.json()) as TikTokQueryResponse;
  if (payload.error && payload.error.code && payload.error.code !== "ok") {
    const { kind, message } = classifyTikTokFailure(payload.error.code, response.status);
    throw new VerificationFailureError(kind, message);
  }

  const videos = payload.data?.videos ?? [];
  // Stage 9D hardening: attribute metrics ONLY to the requested video. The
  // endpoint normally returns only the token user's videos, but if that ever
  // changes (or a proxy/api variant echoes other videos), falling back to
  // `videos[0]` could credit another creator's views to this post. A response
  // without the requested id is "unresolvable", never a metrics source.
  const video = videos.find((v) => v.id === videoId) ?? null;

  if (!video?.id) {
    // The endpoint verifies video ownership against the token's user and
    // omits videos that are not theirs: for our purposes that is "unresolvable".
    return null;
  }

  return video;
}

/**
 * Stage 6 verifiedViews semantics (see x-verifier for the full rationale):
 * verifiedViews equals the platform-reported view count verbatim. No
 * anti-fraud system exists yet, so no views are rejected and no adjustment,
 * estimation or formula is applied.
 */
function buildVerdict(metrics: PlatformPostMetrics): ViewVerificationVerdict {
  return {
    verifiedViews: metrics.views,
    rejectedViews: 0,
    signals: ["tiktok_api_video_query", "no_anti_fraud_yet_verified_equals_reported"],
  };
}

class TikTokVerifier implements PlatformVerifier {
  readonly platform: Platform = "TIKTOK";

  /**
   * Token supplier injection point (Stage 8): the orchestration sets this to
   * resolve the requesting creator's OAuth-connected access token per run.
   * When unset, the verifier falls back to the legacy env credential, and
   * with neither it fails safely (PROVIDER_AUTH) — never fabricating data.
   */
  accessTokenResolver: (() => Promise<string | null>) | null = null;

  private async resolveAccessToken(): Promise<string | null> {
    if (this.accessTokenResolver) {
      const token = await this.accessTokenResolver();

      if (token) {
        return token;
      }
    }

    return process.env.TIKTOK_USER_ACCESS_TOKEN ?? null;
  }

  async fetchPostMetrics(postUrl: string): Promise<PlatformPostMetrics | null> {
    const parsed = parseTikTokVideoUrl(postUrl);

    if (parsed.status !== "RESOLVED") {
      throw new VerificationFailureError("POST_NOT_FOUND", parsed.reason);
    }

    // Creator-granted TikTok user access token with the `video.list` scope —
    // resolved from the requesting creator's OAuth connection (Stage 8) or
    // the legacy env credential. With neither, fail safely and retryable —
    // never fake a verification.
    const accessToken = await this.resolveAccessToken();

    if (!accessToken) {
      throw new VerificationFailureError(
        "PROVIDER_AUTH",
        "TikTok verification requires creator OAuth authorization (video.list scope), which is not implemented yet. No metrics can be retrieved.",
      );
    }

    const video = await queryTikTokVideo(parsed.postId, accessToken);

    if (video === null) {
      return null;
    }

    return mapTikTokVideoToMetrics(video);
  }

  async verifyViews(metrics: PlatformPostMetrics): Promise<ViewVerificationVerdict> {
    return buildVerdict(metrics);
  }
}

export const tiktokVerifier = new TikTokVerifier();

registerVerifier(tiktokVerifier);
