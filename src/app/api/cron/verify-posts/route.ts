import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { verifyPendingCampaignPosts } from "@/services/post-verification.service";

/**
 * Scheduled verification worker endpoint.
 *
 * Calls the existing Stage 5 batch service `verifyPendingCampaignPosts()`,
 * which processes every eligible pending post using the SYSTEM actor and the
 * atomic SUBMITTED → VERIFYING claim (including stale-claim recovery). All
 * verification logic lives in the service — this endpoint only authenticates
 * the scheduler and reports a summary.
 *
 * Security:
 * - Server-side only; requires `Authorization: Bearer $CRON_SECRET`.
 * - Fails closed when CRON_SECRET is unset (never runnable unconfigured).
 * - The SYSTEM actor is decided HERE, never from the request.
 * - No creator/advertiser id, status, or metric is accepted from the request
 *   body — the request carries nothing but the secret.
 *
 * Invocation (Vercel Cron or any external scheduler):
 *   GET/POST /api/cron/verify-posts
 *   Authorization: Bearer <CRON_SECRET>
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Batch size per invocation. Small on purpose: the scheduler re-invokes. */
const DEFAULT_BATCH_LIMIT = 25;

function parseLimit(raw: string | null): number | undefined {
  if (raw === null) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
    return undefined;
  }

  return parsed;
}

async function handle(request: Request): Promise<Response> {
  const authorized = isAuthorizedCronRequest(
    request.headers.get("authorization"),
    process.env.CRON_SECRET,
  );

  if (!authorized) {
    return Response.json(
      { error: "Unauthorized." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const limit = parseLimit(new URL(request.url).searchParams.get("limit"));

  try {
    const summary = await verifyPendingCampaignPosts(
      limit ?? DEFAULT_BATCH_LIMIT,
      { triggeredBy: "cron" },
    );

    return Response.json(
      {
        ok: true,
        processed: summary.processed,
        verified: summary.verified,
        pendingRetry: summary.pendingRetry,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("cron verify-posts failed", error);
    return Response.json(
      { ok: false, error: "Verification run failed. Check server logs." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
