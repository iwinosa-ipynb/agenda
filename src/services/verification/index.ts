import type { Platform } from "@/types";

/**
 * View verification is intentionally NOT implemented yet.
 *
 * This module defines the contract that a real platform integration must
 * satisfy. Nothing here fabricates metrics: callers that need verified views
 * must go through a registered verifier, and currently none are registered.
 */

export type PlatformPostMetrics = {
  platformPostId: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  fetchedAt: Date;
};

export type ViewVerificationVerdict = {
  /**
   * Explicit post-level decision. Absent means the metrics above were
   * verified normally. "POST_REJECTED" means the verifier determined the
   * submitted content itself fails the verification rules — the only signal
   * that may move a post to REJECTED.
   */
  decision?: "METRICS_VERIFIED" | "POST_REJECTED";
  /** Views that survived anti-fraud checks and are eligible for payout. */
  verifiedViews: number;
  /** Views rejected as suspicious / bot traffic. */
  rejectedViews: number;
  signals: string[];
};

export interface PlatformVerifier {
  readonly platform: Platform;
  /** Fetch raw metrics for a post. Returns null when the post cannot be found. */
  fetchPostMetrics(postUrl: string): Promise<PlatformPostMetrics | null>;
  /** Decide how many of the fetched views are eligible for payout. */
  verifyViews(metrics: PlatformPostMetrics): Promise<ViewVerificationVerdict>;
}

/**
 * What a verifier knows about who published the post. Stage 6 scope: the
 * platform-side author identifier, when the official API returns one. There
 * is deliberately NO `verified` flag — identity matching against the stored
 * SocialAccount claims is a later stage and must never be faked here.
 */
export type PostAuthorship = {
  /** Platform-side account id of the post's author, or null when the API does not return one. */
  platformAuthorId: string | null;
};

/**
 * Optional second interface a verifier may implement. The orchestration
 * checks with `instanceof`-free feature detection (`"fetchPostAuthorship" in
 * verifier`) so verifiers that cannot determine authorship simply omit it.
 */
export interface AuthorshipAwareVerifier {
  /**
   * Resolve the platform-side author id for a submitted post URL. Returns
   * null when the API call does not expose authorship information.
   */
  fetchPostAuthorship(postUrl: string): Promise<PostAuthorship | null>;
}

export class VerificationNotImplementedError extends Error {
  constructor(platform: Platform) {
    super(`No verifier is registered for ${platform} yet.`);
    this.name = "VerificationNotImplementedError";
  }
}

/**
 * Why a verification run did not produce a verdict. The distinction matters:
 * only `REJECTED_POST` means the submitted content actually failed the rules
 * — every other kind must never be recorded as a rejection of the creator.
 */
export type VerificationFailureKind =
  /** The verifier is not registered/configured for this platform yet. */
  | "VERIFIER_UNAVAILABLE"
  /** Platform API credentials missing or rejected. */
  | "PROVIDER_AUTH"
  /** The post URL could not be resolved to a platform post. */
  | "POST_NOT_FOUND"
  /** Rate limit, timeout, 5xx or network error — retry later. */
  | "PROVIDER_UNAVAILABLE";

export class VerificationFailureError extends Error {
  constructor(
    public readonly kind: VerificationFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "VerificationFailureError";
  }
}

/** Populated at module load by each verifier's own registration module. */
const verifiers = new Map<Platform, PlatformVerifier>();

export function registerVerifier(verifier: PlatformVerifier): void {
  verifiers.set(verifier.platform, verifier);
}

export function getVerifier(platform: Platform): PlatformVerifier {
  const verifier = verifiers.get(platform);

  if (!verifier) {
    throw new VerificationNotImplementedError(platform);
  }

  return verifier;
}
