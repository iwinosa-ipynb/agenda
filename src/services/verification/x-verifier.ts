import "server-only";

import type { Platform } from "@/types";

import {
  registerVerifier,
  VerificationFailureError,
  type AuthorshipAwareVerifier,
  type PlatformPostMetrics,
  type PlatformVerifier,
  type PostAuthorship,
  type ViewVerificationVerdict,
} from "@/services/verification";
import {
  classifyXHttpStatus,
  mapXPostToMetrics,
  type XPostData,
} from "@/services/verification/metric-mapping";
import { parseXPostUrl } from "@/services/verification/url-parsing";

/**
 * X (Twitter) PlatformVerifier — official X API v2 only.
 *
 * Endpoint:  GET https://api.x.com/2/tweets/:id
 * Auth:      app-only Bearer Token (server-side credential).
 * Scope:     public_metrics are available to app-only auth; non-public
 *            metrics (organic/impressions beyond public) require user context
 *            and are deliberately NOT requested — never fabricated.
 * Docs:      https://docs.x.com/x-api/posts/lookup-post-by-id
 *
 * No scraping, no undocumented endpoints, no mock data.
 */

const X_API_BASE = "https://api.x.com/2";
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * X API v2 returns ONLY `id`, `text` and `edit_history_tweet_ids` by default.
 * Everything this verifier relies on — public_metrics, author_id, created_at —
 * must be requested explicitly via `tweet.fields`, or the API silently omits
 * it and a lookup would "succeed" with no metrics at all. Requesting a field
 * the account tier cannot see is not an error; missing metrics simply stay 0
 * per the mapping convention (nothing estimated).
 */
const TWEET_FIELDS = ["created_at", "public_metrics", "author_id"] as const;

type XPostResponse = {
  data?: XPostData;
  errors?: Array<{ title?: string; detail?: string; type?: string }>;
  title?: string;
  detail?: string;
  type?: string;
};

/** Shared error mapping for fetch/timeout failures. */
function classifyNetworkError(error: unknown): VerificationFailureError {
  if (error instanceof VerificationFailureError) {
    return error;
  }
  return new VerificationFailureError(
    "PROVIDER_UNAVAILABLE",
    "Could not reach the X API. Verification will retry later.",
  );
}

async function fetchXPost(
  postId: string,
  bearerToken: string,
): Promise<XPostData> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;

  try {
    response = await fetch(
      `${X_API_BASE}/tweets/${encodeURIComponent(
        postId,
      )}?tweet.fields=${TWEET_FIELDS.join(",")}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          Accept: "application/json",
        },
        signal: controller.signal,
        cache: "no-store",
      },
    );
  } catch (error) {
    throw classifyNetworkError(error);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const { kind, message } = classifyXHttpStatus(response.status);
    throw new VerificationFailureError(kind, message);
  }

  const payload = (await response.json()) as XPostResponse;

  if (!payload.data?.id) {
    // 200 without data: X returns `errors` entries for unknown IDs.
    throw new VerificationFailureError(
      "POST_NOT_FOUND",
      "X returned no post for this ID.",
    );
  }

  return payload.data;
}

/**
 * Stage 6 verifiedViews semantics: the existing architecture defines verified
 * views as "views that survived anti-fraud checks". No anti-fraud system
 * exists yet, so the only honest verdict is: no views are rejected, and
 * verifiedViews equals the platform-reported view count verbatim — without
 * any adjustment, estimation, or formula. The decision is recorded in
 * `signals` so the report trail is explicit about how it was derived.
 */
function buildVerdict(
  metrics: PlatformPostMetrics,
  authorId: string | null,
): ViewVerificationVerdict {
  const signals = ["x_api_public_metrics", "no_anti_fraud_yet_verified_equals_reported"];

  if (authorId) {
    signals.push(`author:${authorId}`);
  }

  return {
    verifiedViews: metrics.views,
    rejectedViews: 0,
    signals,
  };
}

class XVerifier implements PlatformVerifier, AuthorshipAwareVerifier {
  readonly platform: Platform = "X";

  /**
   * Stage 6 identity limitation (explicit): the X API exposes the post's
   * author_id, and the schema's SocialAccount.platformUserId is the place it
   * would be compared against — but no flow populates that field yet, so no
   * creator-identity claim is verified here. This method only surfaces the
   * platform-side author id for a future matching stage.
   */
  async fetchPostAuthorship(postUrl: string): Promise<PostAuthorship | null> {
    const parsed = parseXPostUrl(postUrl);

    if (parsed.status !== "RESOLVED") {
      throw new VerificationFailureError("POST_NOT_FOUND", parsed.reason);
    }

    const bearerToken = process.env.X_BEARER_TOKEN;

    if (!bearerToken) {
      throw new VerificationFailureError(
        "PROVIDER_AUTH",
        "X verification is not configured (missing X_BEARER_TOKEN).",
      );
    }

    const post = await fetchXPost(parsed.postId, bearerToken);

    return { platformAuthorId: post.author_id ?? null };
  }

  async fetchPostMetrics(postUrl: string): Promise<PlatformPostMetrics | null> {
    const parsed = parseXPostUrl(postUrl);

    if (parsed.status !== "RESOLVED") {
      throw new VerificationFailureError("POST_NOT_FOUND", parsed.reason);
    }

    const bearerToken = process.env.X_BEARER_TOKEN;

    if (!bearerToken) {
      // Credentials are a server-side configuration problem, never a reason
      // to fabricate a result or reject the creator's post.
      throw new VerificationFailureError(
        "PROVIDER_AUTH",
        "X verification is not configured (missing X_BEARER_TOKEN).",
      );
    }

    const post = await fetchXPost(parsed.postId, bearerToken);
    const metrics = mapXPostToMetrics(post);

    return metrics;
  }

  async verifyViews(metrics: PlatformPostMetrics): Promise<ViewVerificationVerdict> {
    return buildVerdict(metrics, null);
  }
}

export const xVerifier = new XVerifier();

registerVerifier(xVerifier);
