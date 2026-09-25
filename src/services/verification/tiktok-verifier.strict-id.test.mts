import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

/**
 * Stage 9D regression tests — TikTok verifier strict video-id attribution.
 *
 * The previous implementation fell back to `videos[0]` when the requested
 * video id was absent from the API response, which could attribute another
 * video's (possibly another creator's) metrics to this post. The hardened
 * verifier returns null instead ("unresolvable", retryable) unless the exact
 * requested id is present.
 *
 * Uses node:test module mocking so no DATABASE_URL, no live TikTok API and
 * no credentials are required.
 */

// ---------------------------------------------------------------------------
// Fetch stub
// ---------------------------------------------------------------------------

let fetchJsonPayload: unknown = {};
let fetchStatus = 200;
let lastFetchUrl = "";
let lastFetchInit: RequestInit | null = null;

async function fetchStub(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  lastFetchUrl = String(input);
  lastFetchInit = init ?? null;

  return new Response(JSON.stringify(fetchJsonPayload), {
    status: fetchStatus,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Module mocks (registered BEFORE importing the verifier)
// ---------------------------------------------------------------------------

function mockModule(specifier: string, exports: Record<string, unknown>): void {
  (mock.module as (spec: string, opts: Record<string, unknown>) => void)(
    specifier,
    { exports },
  );
}

mockModule("server-only", {});

type TikTokVerifierModule = typeof import("@/services/verification/tiktok-verifier");

let verifierModule: TikTokVerifierModule | null = null;

type FetchPostMetricsResult = Awaited<
  ReturnType<
    typeof import("@/services/verification/tiktok-verifier").tiktokVerifier.fetchPostMetrics
  >
>;

function makeVerifier(accessToken: string | null): {
  fetchPostMetrics: (url: string) => Promise<FetchPostMetricsResult>;
} {
  const mod = verifierModule!;
  mod.tiktokVerifier.accessTokenResolver = () => Promise.resolve(accessToken);
  return {
    fetchPostMetrics: (url: string) =>
      mod.tiktokVerifier.fetchPostMetrics(url),
  };
}

describe("Stage 9D — TikTok verifier strict video-id attribution", () => {
  before(async () => {
    // Replace global fetch before the verifier module loads.
    globalThis.fetch = fetchStub as typeof fetch;

    verifierModule = await import(
      "@/services/verification/tiktok-verifier"
    );
  });

  beforeEach(() => {
    fetchJsonPayload = {};
    fetchStatus = 200;
    lastFetchUrl = "";
    lastFetchInit = null;
  });

  const URL_OK = "https://www.tiktok.com/@creator/video/1111111111111111111";

  it("requests the video with the official endpoint and explicit fields", async () => {
    fetchJsonPayload = {
      data: { videos: [{ id: "1111111111111111111", view_count: 900 }] },
    };

    const verifier = makeVerifier("act-token");
    await verifier.fetchPostMetrics(URL_OK);

    assert.match(lastFetchUrl, /open\.tiktokapis\.com\/v2\/video\/query\//);
    assert.match(lastFetchUrl, /fields=id/);
    assert.match(lastFetchUrl, /view_count/);
    const body = JSON.parse(String(lastFetchInit?.body ?? "{}"));
    assert.deepEqual(body.filters.video_ids, ["1111111111111111111"]);
  });

  it("accepts metrics when the response contains exactly the requested video", async () => {
    fetchJsonPayload = {
      data: { videos: [{ id: "1111111111111111111", view_count: 900 }] },
    };

    const verifier = makeVerifier("act-token");
    const metrics = await verifier.fetchPostMetrics(URL_OK);

    assert.equal(metrics?.platformPostId, "1111111111111111111");
    assert.equal(metrics?.views, 900);
  });

  it("returns null instead of attributing a DIFFERENT video's metrics", async () => {
    // The response contains a video — but not the one requested. The old
    // fallback (`?? videos[0]`) would have credited it to this post.
    fetchJsonPayload = {
      data: { videos: [{ id: "9999999999999999999", view_count: 12345 }] },
    };

    const verifier = makeVerifier("act-token");
    const metrics = await verifier.fetchPostMetrics(URL_OK);

    assert.equal(metrics, null);
  });

  it("returns null when the response contains no videos at all", async () => {
    fetchJsonPayload = { data: { videos: [] } };

    const verifier = makeVerifier("act-token");
    const metrics = await verifier.fetchPostMetrics(URL_OK);

    assert.equal(metrics, null);
  });

  it("fails safely without a token (PROVIDER_AUTH), never fabricating metrics", async () => {
    const verifier = makeVerifier(null);

    await assert.rejects(
      verifier.fetchPostMetrics(URL_OK),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "VerificationFailureError",
    );
  });

  it("never sends the token anywhere but the Authorization header", async () => {
    fetchJsonPayload = {
      data: { videos: [{ id: "1111111111111111111", view_count: 900 }] },
    };

    const verifier = makeVerifier("act-secret-token");
    await verifier.fetchPostMetrics(URL_OK);

    const headers = new Headers(lastFetchInit?.headers);
    assert.equal(headers.get("Authorization"), "Bearer act-secret-token");
    const body = JSON.parse(String(lastFetchInit?.body ?? "{}"));
    assert.equal(JSON.stringify(body).includes("act-secret-token"), false);
  });
});
