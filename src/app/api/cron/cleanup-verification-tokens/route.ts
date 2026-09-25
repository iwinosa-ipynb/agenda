import { NextResponse } from "next/server";

import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { cleanupResolvedVerificationChallenges } from "@/services/email-verification.service";

/**
 * Scheduled cleanup of resolved email-verification challenges (Stage 10).
 *
 * Deletes CONSUMED / SUPERSEDED / EXPIRED rows older than 30 days. PENDING
 * challenges are never deleted here — expiry is enforced at consumption
 * time regardless, so cleanup is purely hygiene.
 *
 * Authorization mirrors /api/cron/verify-posts: bearer CRON_SECRET, failing
 * closed when unset. Logs contain counts only — never token hashes.
 */
export async function GET(request: Request): Promise<Response> {
  const authorized = isAuthorizedCronRequest(
    request.headers.get("authorization"),
    process.env.CRON_SECRET,
  );

  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const deleted = await cleanupResolvedVerificationChallenges({
      olderThan: cutoff,
    });

    return NextResponse.json({ deleted });
  } catch (error) {
    console.error("verification-token cleanup failed", error);
    return NextResponse.json(
      { error: "Cleanup failed" },
      { status: 500 },
    );
  }
}
