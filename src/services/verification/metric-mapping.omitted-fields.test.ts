import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  mapXPostToMetrics,
  type XPostData,
} from "@/services/verification/metric-mapping";
import { mapTikTokVideoToMetrics } from "@/services/verification/metric-mapping";

/**
 * Stage 9D regression tests — verifier metric mapping must never invent
 * values when the platform response omits fields (which is exactly what the
 * real X API v2 does for anything not requested via `tweet.fields`).
 *
 * No network, no database, no credentials.
 */

describe("Stage 9D — X metrics mapping with omitted fields", () => {
  it("maps a full public_metrics payload verbatim", () => {
    const post: XPostData = {
      id: "123",
      author_id: "owner-1",
      created_at: "2026-09-21T10:00:00.000Z",
      public_metrics: {
        impression_count: 1250,
        like_count: 10,
        reply_count: 2,
        retweet_count: 3,
        quote_count: 1,
      },
    };

    const metrics = mapXPostToMetrics(post);

    assert.equal(metrics.platformPostId, "123");
    assert.equal(metrics.views, 1250);
    assert.equal(metrics.likes, 10);
    assert.equal(metrics.comments, 2);
    assert.equal(metrics.shares, 4);
  });

  it("stays zero (never invented) when public_metrics is missing entirely", () => {
    // This is the payload shape a real X API v2 lookup returns when
    // `tweet.fields=public_metrics` is NOT requested: id + text only. The
    // mapping must yield zeros here — the fix under test is that the
    // verifier now REQUESTS the fields so this shape stops occurring.
    const post: XPostData = { id: "123" };

    const metrics = mapXPostToMetrics(post);

    assert.equal(metrics.views, 0);
    assert.equal(metrics.likes, 0);
    assert.equal(metrics.comments, 0);
    assert.equal(metrics.shares, 0);
  });

  it("keeps zeros (never NaN) for partially omitted metrics", () => {
    const post: XPostData = {
      id: "123",
      public_metrics: { like_count: 7 },
    };

    const metrics = mapXPostToMetrics(post);

    assert.equal(metrics.likes, 7);
    assert.equal(metrics.views, 0);
    assert.equal(metrics.comments, 0);
    assert.equal(metrics.shares, 0);
  });
});

describe("Stage 9D — TikTok metrics mapping with omitted fields", () => {
  it("maps a full video payload verbatim", () => {
    const video = {
      id: "vid-1",
      view_count: 900,
      like_count: 55,
      comment_count: 4,
      share_count: 2,
    };

    const metrics = mapTikTokVideoToMetrics(video);

    assert.equal(metrics.platformPostId, "vid-1");
    assert.equal(metrics.views, 900);
    assert.equal(metrics.likes, 55);
    assert.equal(metrics.comments, 4);
    assert.equal(metrics.shares, 2);
  });

  it("keeps zeros (never invented) for omitted metrics", () => {
    const metrics = mapTikTokVideoToMetrics({ id: "vid-1" });

    assert.equal(metrics.views, 0);
    assert.equal(metrics.likes, 0);
    assert.equal(metrics.comments, 0);
    assert.equal(metrics.shares, 0);
  });
});
