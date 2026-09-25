import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it, mock } from "node:test";

import {
  buildObservationKey,
  MAX_METRIC_VALUE,
} from "@/services/verified-views-accounting";
import type {
  AuthorshipAwareVerifier,
  PlatformVerifier,
} from "@/services/verification";

/**
 * Stage 9B integration tests — verified-view accounting inside the post
 * verification orchestration (src/services/post-verification.service.ts).
 *
 * Strategy:
 *   - The Prisma client is replaced with an in-memory stub via node:test
 *     module mocking, so no DATABASE_URL is required.
 *   - The "server-only" guard is mocked out (it throws outside RSC).
 *   - The per-creator credential lookup is mocked (stands in for the Stage 8
 *     OAuth connection state).
 *   - The platform verifier is a registered fake, so no X/TikTok API
 *     credentials are required. It is registered AFTER the service module is
 *     imported so it overwrites the real X verifier in the registry.
 *
 * Requires the --experimental-test-module-mocks flag (wired into the npm
 * test script; supported on Node >= 22.3).
 */

// ---------------------------------------------------------------------------
// Mock state + in-memory Prisma stub
// ---------------------------------------------------------------------------

type CallLog = { method: string; args: unknown[] };

const calls: CallLog[] = [];

type PostRow = {
  id: string;
  status: string;
  platform: string;
  postUrl: string;
  verifiedViews: number;
  campaign: { id: string; advertiserId: string };
  creator: { id: string };
};

let postRecord: PostRow | null = null;
let updateManyCount = 1;
let failPostUpdate = false;
let observationCreateThrowsP2002 = false;
let findManyResult: unknown[] = [];
let transactionImpl:
  | ((fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>)
  | null = null;

/** Captured postVerificationObservation.create payloads (successful writes). */
let observationCreates: Record<string, unknown>[] = [];
/** Captured campaignPost.update payloads. */
let postUpdates: Record<string, unknown>[] = [];

const prismaStub = {
  campaignPost: {
    findUnique: (args: unknown) => {
      calls.push({ method: "campaignPost.findUnique", args: [args] });
      return Promise.resolve(postRecord ? structuredClone(postRecord) : null);
    },
    updateMany: (args: unknown) => {
      calls.push({ method: "campaignPost.updateMany", args: [args] });
      return Promise.resolve({ count: updateManyCount });
    },
    update: (args: unknown) => {
      calls.push({ method: "campaignPost.update", args: [args] });
      const data = (args as { data: Record<string, unknown> }).data;
      postUpdates.push(structuredClone(data));
      if (failPostUpdate) {
        return Promise.reject(new Error("simulated post update failure"));
      }
      return Promise.resolve({});
    },
    findMany: (args: unknown) => {
      calls.push({ method: "campaignPost.findMany", args: [args] });
      return Promise.resolve(structuredClone(findManyResult));
    },
  },
  $transaction: (fn: (tx: unknown) => Promise<unknown>) => {
    calls.push({ method: "$transaction", args: [] });
    if (!transactionImpl) {
      throw new Error("transactionImpl not configured");
    }
    return transactionImpl(fn);
  },
  postVerificationObservation: {
    create: (args: unknown) => {
      calls.push({ method: "postVerificationObservation.create", args: [args] });
      if (observationCreateThrowsP2002) {
        // Unique-constraint violation, shaped like Prisma's P2002.
        return Promise.reject({ code: "P2002" });
      }
      observationCreates.push(
        structuredClone((args as { data: Record<string, unknown> }).data),
      );
      return Promise.resolve({ id: "obs-1" });
    },
  },
};

// ---------------------------------------------------------------------------
// Module mocks — registered BEFORE anything under test is imported. The
// modules under test import these, so the mocks must already be in place.
// ---------------------------------------------------------------------------

/**
 * @types/node still types MockModuleOptions as `namedExports`; the runtime
 * prefers `exports` and treats `namedExports` as deprecated. This wrapper
 * keeps call sites type-clean while using the non-deprecated runtime shape.
 */
function mockModule(specifier: string, exports: Record<string, unknown>): void {
  (mock.module as (spec: string, opts: Record<string, unknown>) => void)(
    specifier,
    { exports },
  );
}

// "server-only" throws outside React Server Components; the modules under
// test import it. Mock it out so the service code can load in plain Node.
mockModule("server-only", {});

mockModule("@/lib/prisma", { prisma: prismaStub });

let credentialsResult: { platformUserId: string; accessToken: string | null } | null =
  null;

mockModule("@/services/social-account.service", {
  getCreatorPlatformCredentials: () => Promise.resolve(credentialsResult),
});

// Load the modules under test AFTER the mocks are registered.
type VerificationService = typeof import("@/services/post-verification.service");
type VerificationModule = typeof import("@/services/verification");

let service: VerificationService | null = null;

const FIXED_AT = new Date("2026-09-22T10:00:00.000Z");

/** Platform metrics shape returned by the fake verifier. */
function metrics(views: number) {
  return {
    platformPostId: "tweet-1",
    views,
    likes: 10,
    comments: 2,
    shares: 3,
    fetchedAt: FIXED_AT,
  };
}

/** Configurable fake verifier behavior (overridden per test). */
let fetchImpl: (url: string) => Promise<unknown> = () =>
  Promise.resolve(metrics(1250));
let verifyImpl: () => Promise<unknown> = () =>
  Promise.resolve({
    decision: "METRICS_VERIFIED",
    verifiedViews: 1250,
    rejectedViews: 0,
    signals: [],
  });
let authorshipImpl: () => Promise<unknown> = () =>
  Promise.resolve({ platformAuthorId: "owner-1" });

function defaultPost(): PostRow {
  return {
    id: "post-1",
    status: "SUBMITTED",
    platform: "X",
    postUrl: "https://x.com/creator/status/1",
    verifiedViews: 0,
    campaign: { id: "c-1", advertiserId: "adv-1" },
    creator: { id: "cr-1" },
  };
}

function methods(name: string): CallLog[] {
  return calls.filter((call) => call.method === name);
}

/**
 * Run a verification and unwrap the success branch, so tests can read
 * `result.outcome` without repeating the ActionResult narrowing.
 */
async function runVerification(postId: string) {
  const result = await service!.verifyCampaignPostById(postId, { kind: "SYSTEM" });
  if (!result.success) {
    throw new Error(`verification call failed: ${result.error}`);
  }
  return result.data;
}

/** Last updateMany payload's data, for claim/release assertions. */
function lastUpdateManyData(): Record<string, unknown> {
  const updateMany = methods("campaignPost.updateMany").at(-1);
  return (updateMany?.args[0] as { data: Record<string, unknown> }).data;
}

describe("Stage 9B — verification → verified-views accounting integration", () => {
  let restoreConsoleError: (() => void) | null = null;

  before(async () => {
    // Import the service FIRST so the real verifier modules register, then
    // overwrite the registry entry with the fake (Map.set wins).
    service = (await import(
      "@/services/post-verification.service"
    )) as VerificationService;
    const verification = (await import(
      "@/services/verification"
    )) as VerificationModule;

    const fakeVerifier: PlatformVerifier & AuthorshipAwareVerifier = {
      platform: "X",
      fetchPostMetrics: (url: string) =>
        fetchImpl(url) as ReturnType<PlatformVerifier["fetchPostMetrics"]>,
      verifyViews: () =>
        verifyImpl() as ReturnType<PlatformVerifier["verifyViews"]>,
      fetchPostAuthorship: () =>
        authorshipImpl() as ReturnType<AuthorshipAwareVerifier["fetchPostAuthorship"]>,
    };
    verification.registerVerifier(fakeVerifier);
  });

  beforeEach(() => {
    calls.length = 0;
    observationCreates = [];
    postUpdates = [];
    postRecord = defaultPost();
    updateManyCount = 1;
    failPostUpdate = false;
    observationCreateThrowsP2002 = false;
    findManyResult = [];
    transactionImpl = (fn) => fn(prismaStub);
    credentialsResult = { platformUserId: "owner-1", accessToken: null };
    fetchImpl = () => Promise.resolve(metrics(1250));
    verifyImpl = () =>
      Promise.resolve({
        decision: "METRICS_VERIFIED",
        verifiedViews: 1250,
        rejectedViews: 0,
        signals: [],
      });
    authorshipImpl = () => Promise.resolve({ platformAuthorId: "owner-1" });

    // Failure paths log via console.error; keep the test output clean.
    const consoleMock = mock.method(console, "error", () => {});
    restoreConsoleError = () => consoleMock.mock.restore();
  });

  afterEach(() => {
    restoreConsoleError?.();
    restoreConsoleError = null;
  });

  // -----------------------------------------------------------------------
  // Spec scenario 1: successful verification records an observation
  // -----------------------------------------------------------------------
  it("records a trusted observation with verbatim platform metrics", async () => {
    const result = await runVerification("post-1");

    assert.equal(result.outcome, "VERIFIED");

    // Exactly one observation, written inside the verification transaction.
    assert.equal(methods("$transaction").length, 1);
    assert.equal(observationCreates.length, 1);

    const observation = observationCreates[0] as Record<string, unknown>;
    assert.equal(observation.postId, "post-1");
    assert.equal(observation.platform, "X");
    assert.equal(observation.platformPostId, "tweet-1");
    assert.deepEqual(observation.observedAt, FIXED_AT);
    // Cumulative metrics stored verbatim — nothing invented or estimated.
    assert.equal(observation.views, 1250);
    assert.equal(observation.likes, 10);
    assert.equal(observation.comments, 2);
    assert.equal(observation.shares, 3);
    assert.equal(observation.verifiedViews, 1250);
    assert.equal(observation.verificationResult, "VERIFIED");
    assert.equal(observation.integrityStatus, "CLEAN");
    assert.deepEqual(observation.integrityChecks, []);
    assert.equal(
      observation.observationKey,
      buildObservationKey("post-1", "tweet-1", FIXED_AT),
    );
  });

  // -----------------------------------------------------------------------
  // Spec scenario 2: 1000 → 1250 results in 1250 verified views (NOT 2250)
  // -----------------------------------------------------------------------
  it("updates 1000 → 1250 to 1250 verified views, never a sum", async () => {
    postRecord = { ...defaultPost(), verifiedViews: 1000 };
    fetchImpl = () => Promise.resolve(metrics(1250));

    const result = await runVerification("post-1");

    assert.equal(result.outcome, "VERIFIED");
    assert.equal(postUpdates.length, 1);
    assert.equal(postUpdates[0]?.verifiedViews, 1250);
    assert.equal(observationCreates[0]?.verifiedViews, 1250);
    assert.equal(observationCreates[0]?.integrityStatus, "CLEAN");
  });

  // -----------------------------------------------------------------------
  // Spec scenario 3: repeated verification at 1250 stays 1250 (not 2500)
  // -----------------------------------------------------------------------
  it("keeps 1250 when the provider repeats the same cumulative count", async () => {
    postRecord = { ...defaultPost(), verifiedViews: 1250 };
    fetchImpl = () => Promise.resolve(metrics(1250));

    const result = await runVerification("post-1");

    assert.equal(result.outcome, "VERIFIED");
    assert.equal(postUpdates[0]?.verifiedViews, 1250);
    assert.equal(observationCreates[0]?.integrityStatus, "CLEAN");
  });

  // -----------------------------------------------------------------------
  // Spec scenario 4: lower provider count → REVIEW, high-water preserved
  // -----------------------------------------------------------------------
  it("preserves the 1250 high-water and flags REVIEW when the provider reports 1100", async () => {
    postRecord = { ...defaultPost(), verifiedViews: 1250 };
    fetchImpl = () => Promise.resolve(metrics(1100));

    const result = await runVerification("post-1");

    // The post stays VERIFIED — a provider anomaly is not a rejection.
    assert.equal(result.outcome, "VERIFIED");

    const observation = observationCreates[0] as Record<string, unknown>;
    // The raw provider number is stored verbatim on the observation...
    assert.equal(observation.views, 1100);
    // ...but the trusted accounting value is the preserved high-water.
    assert.equal(observation.verifiedViews, 1250);
    assert.equal(observation.integrityStatus, "REVIEW");
    assert.deepEqual(observation.integrityChecks, ["cumulative_view_decrease"]);
    assert.equal(postUpdates[0]?.verifiedViews, 1250);
  });

  // -----------------------------------------------------------------------
  // Spec scenario 5: ownership mismatch does not create a trusted observation
  // -----------------------------------------------------------------------
  it("rejects on ownership mismatch without recording any observation", async () => {
    credentialsResult = { platformUserId: "owner-SOMEONE_ELSE", accessToken: null };

    const result = await runVerification("post-1");

    assert.equal(result.outcome, "REJECTED");
    assert.equal(methods("$transaction").length, 0);
    assert.equal(observationCreates.length, 0);
    assert.equal(postUpdates.length, 0);
    // The post moved to REJECTED through the existing rejection path.
    assert.equal(lastUpdateManyData().status, "REJECTED");
  });

  it("records nothing when ownership cannot be established (stays retryable)", async () => {
    credentialsResult = null;

    const result = await runVerification("post-1");

    assert.equal(result.outcome, "PENDING_RETRY");
    assert.equal(methods("$transaction").length, 0);
    assert.equal(observationCreates.length, 0);
    assert.equal(postUpdates.length, 0);
  });

  // -----------------------------------------------------------------------
  // Spec scenario 6: verifier failure / retry creates no fake observations
  // -----------------------------------------------------------------------
  it("records nothing when the platform API fails, and restores the claim", async () => {
    fetchImpl = () =>
      Promise.reject(
        new (class extends Error {
          kind = "PROVIDER_UNAVAILABLE";
        })("provider down"),
      );

    const result = await runVerification("post-1");

    assert.equal(result.outcome, "PENDING_RETRY");
    assert.equal(methods("$transaction").length, 0);
    assert.equal(observationCreates.length, 0);
    assert.equal(postUpdates.length, 0);
    // Claim released: the post returned to its pre-claim status.
    assert.equal(lastUpdateManyData().status, "SUBMITTED");
  });

  it("records nothing when the platform cannot find the post yet", async () => {
    fetchImpl = () => Promise.resolve(null);

    const result = await runVerification("post-1");

    assert.equal(result.outcome, "PENDING_RETRY");
    assert.equal(methods("$transaction").length, 0);
    assert.equal(observationCreates.length, 0);
  });

  it("records nothing when the verifier itself rejects the post", async () => {
    verifyImpl = () =>
      Promise.resolve({
        decision: "POST_REJECTED",
        verifiedViews: 0,
        rejectedViews: 1250,
        signals: [],
      });

    const result = await runVerification("post-1");

    assert.equal(result.outcome, "REJECTED");
    assert.equal(methods("$transaction").length, 0);
    assert.equal(observationCreates.length, 0);
    assert.equal(postUpdates.length, 0);
  });

  it("restores VERIFIED state when a resync of a verified post fails", async () => {
    // Re-verification (resync) of an already-VERIFIED post.
    postRecord = { ...defaultPost(), status: "VERIFIED", verifiedViews: 1250 };
    fetchImpl = () => Promise.reject(new Error("network outage"));

    const result = await runVerification("post-1");

    assert.equal(result.outcome, "PENDING_RETRY");
    assert.equal(observationCreates.length, 0);
    // A failed resync must not strip the verified state or stored views.
    assert.equal(lastUpdateManyData().status, "VERIFIED");
  });

  // -----------------------------------------------------------------------
  // Spec scenario 7: invalid metrics are never accepted as VERIFIED
  // -----------------------------------------------------------------------
  it("does not mark VERIFIED on negative, NaN, Infinity, fractional or out-of-range metrics", async () => {
    const invalidViews = [
      -5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1250.5,
      MAX_METRIC_VALUE + 1,
    ];

    for (const views of invalidViews) {
      calls.length = 0;
      observationCreates = [];
      postUpdates = [];
      postRecord = { ...defaultPost(), verifiedViews: 1250 };
      fetchImpl = () => Promise.resolve(metrics(views));

      const result = await runVerification("post-1");

      assert.equal(result.outcome, "PENDING_RETRY", `views=${String(views)}`);
      // No VERIFIED-shaped write, no observation, no invented replacement.
      assert.equal(methods("$transaction").length, 0, `views=${String(views)}`);
      assert.equal(observationCreates.length, 0, `views=${String(views)}`);
      assert.equal(postUpdates.length, 0, `views=${String(views)}`);
    }
  });

  // -----------------------------------------------------------------------
  // Spec scenario 8: duplicate observation is idempotent
  // -----------------------------------------------------------------------
  it("treats a duplicate observation as an idempotent no-op", async () => {
    postRecord = { ...defaultPost(), verifiedViews: 1250 };
    fetchImpl = () => Promise.resolve(metrics(1250));
    // The unique constraint on observationKey rejects the second insert.
    observationCreateThrowsP2002 = true;

    const result = await runVerification("post-1");

    // The duplicate insert loses the race deterministically — the run still
    // completes without error and never double-counts.
    assert.equal(result.outcome, "VERIFIED");
    assert.equal(methods("postVerificationObservation.create").length, 1);
    assert.equal(observationCreates.length, 0);
    assert.equal(postUpdates[0]?.verifiedViews, 1250);
  });

  // -----------------------------------------------------------------------
  // Task 5: transaction safety
  // -----------------------------------------------------------------------
  it("does not record an observation when the post update fails (rolled back together)", async () => {
    failPostUpdate = true;

    const result = await runVerification("post-1");

    assert.equal(result.outcome, "PENDING_RETRY");
    assert.equal(observationCreates.length, 0);
    // Claim released so the post stays retryable.
    assert.equal(lastUpdateManyData().status, "SUBMITTED");
  });

  // -----------------------------------------------------------------------
  // Task 7: campaign totals read the persisted per-post accounting
  // -----------------------------------------------------------------------
  describe("getCampaignVerifiedViews", () => {
    it("aggregates persisted eligible posts without double-counting", async () => {
      const { getCampaignVerifiedViews } = await import(
        "@/services/verified-views.service"
      );

      findManyResult = [
        {
          id: "p1",
          platform: "X",
          status: "VERIFIED",
          verifiedViews: 1250,
          creator: { socialAccounts: [{ platform: "X" }] },
          observations: [{ integrityStatus: "CLEAN" }],
        },
        {
          id: "p2",
          platform: "X",
          status: "REJECTED",
          verifiedViews: 9999,
          creator: { socialAccounts: [{ platform: "X" }] },
          observations: [],
        },
      ];

      const totals = await getCampaignVerifiedViews("c-1");

      assert.equal(totals?.totalVerifiedViews, 1250);
      assert.equal(totals?.eligiblePostCount, 1);
      assert.equal(totals?.verifiedPostCount, 1);
      assert.equal(totals?.hasReviewFlag, false);
    });

    it("surfaces the persisted REVIEW flag in campaign totals", async () => {
      const { getCampaignVerifiedViews } = await import(
        "@/services/verified-views.service"
      );

      findManyResult = [
        {
          id: "p1",
          platform: "X",
          status: "VERIFIED",
          verifiedViews: 1250,
          creator: { socialAccounts: [{ platform: "X" }] },
          observations: [{ integrityStatus: "REVIEW" }],
        },
      ];

      const totals = await getCampaignVerifiedViews("c-1");

      assert.equal(totals?.totalVerifiedViews, 1250);
      assert.equal(totals?.hasReviewFlag, true);
    });
  });
});
