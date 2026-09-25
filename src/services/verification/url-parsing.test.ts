import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyTikTokFailure,
  classifyXHttpStatus,
  mapTikTokVideoToMetrics,
  mapXPostToMetrics,
} from "@/services/verification/metric-mapping";
import {
  parseTikTokVideoUrl,
  parseXPostUrl,
} from "@/services/verification/url-parsing";

describe("parseXPostUrl", () => {
  it("accepts a valid x.com status URL", () => {
    const result = parseXPostUrl("https://x.com/user1/status/1234567890123456789");

    assert.equal(result.status, "RESOLVED");
    assert.ok(result.status === "RESOLVED" && result.postId === "1234567890123456789");
  });

  it("accepts a valid twitter.com status URL", () => {
    const result = parseXPostUrl("https://twitter.com/user1/status/1234567890123456789");

    assert.equal(result.status, "RESOLVED");
    assert.ok(result.status === "RESOLVED" && result.postId === "1234567890123456789");
  });

  it("accepts subdomains, /statuses/ and query strings", () => {
    const r1 = parseXPostUrl("https://mobile.x.com/user1/status/42?foo=bar");
    assert.ok(r1.status === "RESOLVED" && r1.postId === "42");

    const r2 = parseXPostUrl("https://x.com/user1/statuses/99");
    assert.ok(r2.status === "RESOLVED" && r2.postId === "99");
  });

  it("rejects a malformed status URL (missing ID)", () => {
    const result = parseXPostUrl("https://x.com/user1/status");
    assert.equal(result.status, "UNRESOLVED");
  });

  it("rejects a non-numeric ID", () => {
    const result = parseXPostUrl("https://x.com/user1/status/notanumber");
    assert.equal(result.status, "UNRESOLVED");
  });

  it("rejects a non-X host", () => {
    const result = parseXPostUrl("https://example.com/user1/status/123");
    assert.equal(result.status, "UNRESOLVED");
  });

  it("rejects http (non-https) URLs", () => {
    const result = parseXPostUrl("http://x.com/user1/status/123");
    assert.equal(result.status, "UNRESOLVED");
  });

  it("rejects an invalid URL string", () => {
    const result = parseXPostUrl("not a url");
    assert.equal(result.status, "UNRESOLVED");
  });
});

describe("parseTikTokVideoUrl", () => {
  it("accepts a valid standard video URL", () => {
    const result = parseTikTokVideoUrl(
      "https://www.tiktok.com/@somecreator/video/7123456789012345678",
    );

    assert.equal(result.status, "RESOLVED");
    assert.ok(result.status === "RESOLVED" && result.postId === "7123456789012345678");
  });

  it("accepts a /photo/ URL and regional subdomain", () => {
    const r1 = parseTikTokVideoUrl("https://www.tiktok.com/@user/photo/7123456789");
    assert.ok(r1.status === "RESOLVED" && r1.postId === "7123456789");

    const r2 = parseTikTokVideoUrl("https://www.tiktok.com/@user/video/7123456789?lang=en");
    assert.ok(r2.status === "RESOLVED" && r2.postId === "7123456789");
  });

  it("rejects a short/share URL explicitly instead of resolving it", () => {
    const result = parseTikTokVideoUrl("https://vm.tiktok.com/ZMabcdef123/");
    assert.equal(result.status, "UNRESOLVED");
    assert.ok(result.status === "UNRESOLVED" && result.reason.includes("short/share"));
  });

  it("rejects a malformed video URL (missing ID)", () => {
    const result = parseTikTokVideoUrl("https://www.tiktok.com/@user/video");
    assert.equal(result.status, "UNRESOLVED");
  });

  it("rejects a non-numeric video ID", () => {
    const result = parseTikTokVideoUrl("https://www.tiktok.com/@user/video/abc");
    assert.equal(result.status, "UNRESOLVED");
  });

  it("rejects a non-TikTok host", () => {
    const result = parseTikTokVideoUrl("https://example.com/@user/video/123");
    assert.equal(result.status, "UNRESOLVED");
  });

  it("rejects http (non-https) URLs", () => {
    const result = parseTikTokVideoUrl("http://www.tiktok.com/@user/video/123");
    assert.equal(result.status, "UNRESOLVED");
  });
});

describe("mapXPostToMetrics", () => {
  it("maps public_metrics onto the verifier contract", () => {
    const metrics = mapXPostToMetrics({
      id: "123",
      author_id: "999",
      created_at: "2026-01-15T10:00:00.000Z",
      public_metrics: {
        retweet_count: 7,
        reply_count: 3,
        like_count: 38,
        quote_count: 1,
        bookmark_count: 2,
        impression_count: 1250,
      },
    });

    assert.equal(metrics.platformPostId, "123");
    assert.equal(metrics.views, 1250);
    assert.equal(metrics.likes, 38);
    assert.equal(metrics.comments, 3);
    assert.equal(metrics.shares, 8); // retweets + quotes
  });

  it("keeps missing metrics at 0 instead of inventing values", () => {
    const metrics = mapXPostToMetrics({ id: "555" });

    assert.equal(metrics.views, 0);
    assert.equal(metrics.likes, 0);
    assert.equal(metrics.comments, 0);
    assert.equal(metrics.shares, 0);
  });
});

describe("mapTikTokVideoToMetrics", () => {
  it("maps the video object verbatim onto the verifier contract", () => {
    const metrics = mapTikTokVideoToMetrics({
      id: "7123456789012345678",
      view_count: 1000,
      like_count: 100,
      comment_count: 10,
      share_count: 5,
    });

    assert.equal(metrics.platformPostId, "7123456789012345678");
    assert.equal(metrics.views, 1000);
    assert.equal(metrics.likes, 100);
    assert.equal(metrics.comments, 10);
    assert.equal(metrics.shares, 5);
  });

  it("keeps missing metrics at 0 instead of inventing values", () => {
    const metrics = mapTikTokVideoToMetrics({ id: "1" });

    assert.equal(metrics.views, 0);
    assert.equal(metrics.likes, 0);
    assert.equal(metrics.comments, 0);
    assert.equal(metrics.shares, 0);
  });
});

describe("failure classification", () => {
  it("maps X 401/403 to PROVIDER_AUTH", () => {
    assert.equal(classifyXHttpStatus(401).kind, "PROVIDER_AUTH");
    assert.equal(classifyXHttpStatus(403).kind, "PROVIDER_AUTH");
  });

  it("maps X 404 to POST_NOT_FOUND and 429 to PROVIDER_UNAVAILABLE", () => {
    assert.equal(classifyXHttpStatus(404).kind, "POST_NOT_FOUND");
    assert.equal(classifyXHttpStatus(429).kind, "PROVIDER_UNAVAILABLE");
    assert.equal(classifyXHttpStatus(500).kind, "PROVIDER_UNAVAILABLE");
  });

  it("maps TikTok token error codes to PROVIDER_AUTH", () => {
    assert.equal(classifyTikTokFailure("access_token_expired", 200).kind, "PROVIDER_AUTH");
    assert.equal(classifyTikTokFailure("scope_not_authorized", 200).kind, "PROVIDER_AUTH");
  });

  it("maps TikTok 404/429/5xx correctly", () => {
    assert.equal(classifyTikTokFailure(undefined, 404).kind, "POST_NOT_FOUND");
    assert.equal(classifyTikTokFailure(undefined, 429).kind, "PROVIDER_UNAVAILABLE");
    assert.equal(classifyTikTokFailure(undefined, 500).kind, "PROVIDER_UNAVAILABLE");
  });
});
