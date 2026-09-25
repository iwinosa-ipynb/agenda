import { NextResponse } from "next/server";

import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { sweepMilestoneTimers } from "@/services/payments/milestone-review.service";

/**
 * Stage 13B — milestone sweep endpoint.
 *
 * Same authorization shape as the other cron endpoints: bearer CRON_SECRET,
 * failing closed when unset. The sweep NEVER releases money: it only records
 * advertiser-caused delay evidence for overdue review windows and completes
 * re-verification when a corrected post has verified. autoReleasePerformed is
 * always false by construction.
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
    const report = await sweepMilestoneTimers();

    return NextResponse.json(report);
  } catch (error) {
    console.error("milestone sweep failed", error);
    return NextResponse.json({ error: "Sweep failed" }, { status: 500 });
  }
}
