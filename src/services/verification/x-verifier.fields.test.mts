import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Stage 9D regression tests — X verifier must explicitly request the tweet
 * fields it depends on. X API v2 returns only `id`, `text` and
 * `edit_history_tweet_ids` by default; without `tweet.fields=public_metrics,
 * author_id,created_at` a lookup "succeeds" with no metrics at all, which
 * previously produced all-zero VERIFIED posts (fabricated zeros).
 *
 * Uses node:test module mocking so no DATABASE_URL, no live X API and no
 * credentials are required.
 */

// ---------------------------------------------------------------------------
// Fetch stub
// ---------------------------------------------------------------------------

let fetchJsonPayload: unknown = {};
let fetchStatus = 200;
let lastFetchUrl = "";

// Signature must stay compatible with global fetch; the request init is not
// needed here, so its parameter is typed but intentionally unnamed.
const fetchStub = async (
  input: string | URL | Request,
): Promise<Response> => {
  lastFetchUrl = String(input);

  return new Response(JSON.stringify(fetchJsonPayload), {
    status: fetchStatus,
    headers: { "Content-Type": "application/json" },
  });
};

function mockModule(specifier: string, exports: Record<string, unknown>): void {
  (mock.module as (spec: string, opts: Record<string, unknown>) => void)(
    specifier,
    { exports },
  );
}

mockModule("server-only", {});

type XVerifierModule = typeof import("@/services/verification/x-verifier");

let verifierModule: XVerifierModule | null = null;

describe("Stage 9D — X verifier requests the fields it relies on", () => {
  before(async () => {
    globalThis.fetch = fetchStub as typeof fetch;
    verifierModule = await import("@/services/verification/x-verifier");
  });

  beforeEach(() => {
    fetchJsonPayload = {};
    fetchStatus = 200;
    lastFetchUrl = "";
  });

  const URL_OK = "https://x.com/creator/status/1234567890";

  it("includes tweet.fields with public_metrics, author_id and created_at", async () => {
    process.env.X_BEARER_TOKEN = "test-bearer";

    fetchJsonPayload = {
      data: {
        id: "1234567890",
        author_id: "owner-1",
        created_at: "2026-09-21T10:00:00.000Z",
        public_metrics: {
          impression_count: 1250,
          like_count: 10,
          reply_count: 2,
          retweet_count: 3,
          quote_count: 1,
        },
      },
    };

    const metrics =
      await verifierModule!.xVerifier.fetchPostMetrics(URL_OK);

    assert.match(lastFetchUrl, /api\.x\.com\/2\/tweets\/1234567890/);
    assert.match(
      lastFetchUrl,
      /tweet\.fields=created_at,public_metrics,author_id/,
    );

    assert.equal(metrics?.views, 1250);
    assert.equal(metrics?.likes, 10);
    assert.equal(metrics?.comments, 2);
    assert.equal(metrics?.shares, 4);
  });

  it("exposes the post author id for the ownership gate", async () => {
    process.env.X_BEARER_TOKEN = "test-bearer";

    fetchJsonPayload = {
      data: {
        id: "1234567890",
        author_id: "owner-9",
        public_metrics: { impression_count: 5 },
      },
    };

    const authorship =
      await verifierModule!.xVerifier.fetchPostAuthorship(URL_OK);

    assert.equal(authorship?.platformAuthorId, "owner-9");
  });

  it("fails safely without credentials (PROVIDER_AUTH), never fabricating metrics", async () => {
    const previous = process.env.X_BEARER_TOKEN;
    delete process.env.X_BEARER_TOKEN;

    try {
      await assert.rejects(
        verifierModule!.xVerifier.fetchPostMetrics(URL_OK),
        (error: unknown) =>
          error instanceof Error && error.name === "VerificationFailureError",
      );
    } finally {
      process.env.X_BEARER_TOKEN = previous;
    }
  });
});
