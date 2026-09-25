/**
 * Pure URL → platform post ID parsing for the verification architecture.
 *
 * These functions are deliberately dependency-free and side-effect-free so
 * they can be unit tested without network or database access. No scraping,
 * no redirects, no undocumented endpoints: a URL that cannot yield an ID from
 * its own structure returns an explicit unresolved result.
 */

export type ParsedPostId =
  | { status: "RESOLVED"; postId: string }
  | { status: "UNRESOLVED"; reason: string };

/**
 * X / Twitter post URLs:
 *   https://x.com/<user>/status/<tweetId>
 *   https://twitter.com/<user>/status/<tweetId>
 *
 * Query strings, hash fragments and subdomains are tolerated; a URL whose
 * second path segment is not `status`/`statuses` or whose ID is not numeric
 * is rejected with an explicit reason.
 */
export function parseXPostUrl(rawUrl: string): ParsedPostId {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return { status: "UNRESOLVED", reason: "The post URL is not a valid URL." };
  }

  if (url.protocol !== "https:") {
    return { status: "UNRESOLVED", reason: "The post URL must use https." };
  }

  const host = url.hostname.toLowerCase();
  const isXHost =
    host === "x.com" ||
    host.endsWith(".x.com") ||
    host === "twitter.com" ||
    host.endsWith(".twitter.com");

  if (!isXHost) {
    return { status: "UNRESOLVED", reason: "The post URL is not an x.com or twitter.com link." };
  }

  const segments = url.pathname.split("/").filter(Boolean);

  // /<username>/status/<id> or /<username>/statuses/<id>
  if (segments.length < 3 || (segments[1] !== "status" && segments[1] !== "statuses")) {
    return {
      status: "UNRESOLVED",
      reason: "X post links must look like https://x.com/<user>/status/<id>.",
    };
  }

  const tweetId = segments[2];

  if (!/^\d{1,25}$/.test(tweetId)) {
    return { status: "UNRESOLVED", reason: "The X post ID in the URL is malformed." };
  }

  return { status: "RESOLVED", postId: tweetId };
}

/**
 * TikTok video URLs:
 *   https://www.tiktok.com/@<user>/video/<videoId>
 *   (also accepts /photo/ and regional subdomains)
 *
 * A short/share URL (vm.tiktok.com, vt.tiktok.com, /t/<code>) cannot provide
 * an ID from its own structure and is explicitly unresolved — resolving it
 * would require a redirect fetch, which this architecture deliberately does
 * not do (no scraping, no undocumented resolution mechanism).
 */
export function parseTikTokVideoUrl(rawUrl: string): ParsedPostId {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return { status: "UNRESOLVED", reason: "The post URL is not a valid URL." };
  }

  if (url.protocol !== "https:") {
    return { status: "UNRESOLVED", reason: "The post URL must use https." };
  }

  const host = url.hostname.toLowerCase();

  if (host !== "tiktok.com" && !host.endsWith(".tiktok.com")) {
    return { status: "UNRESOLVED", reason: "The post URL is not a tiktok.com link." };
  }

  // Short/share links cannot be resolved to a video ID without fetching the
  // redirect. Return an explicit unresolved result instead of scraping.
  if (host === "vm.tiktok.com" || host === "vt.tiktok.com" || host === "m.tiktok.com") {
    return {
      status: "UNRESOLVED",
      reason:
        "TikTok short/share links cannot be verified safely. Please submit the full https://www.tiktok.com/@user/video/<id> URL.",
    };
  }

  const segments = url.pathname.split("/").filter(Boolean);

  // /@<user>/video/<id> or /@<user>/photo/<id>
  if (
    segments.length < 3 ||
    !segments[0].startsWith("@") ||
    (segments[1] !== "video" && segments[1] !== "photo")
  ) {
    return {
      status: "UNRESOLVED",
      reason: "TikTok post links must look like https://www.tiktok.com/@user/video/<id>.",
    };
  }

  const videoId = segments[2];

  if (!/^\d{1,25}$/.test(videoId)) {
    return { status: "UNRESOLVED", reason: "The TikTok video ID in the URL is malformed." };
  }

  return { status: "RESOLVED", postId: videoId };
}
