import { NextResponse } from "next/server";

import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { runReconciliationScan } from "@/services/payments/reconciliation.service";

/**
 * Stage 13A — reconciliation scan endpoint (stub boundary).
 *
 * Same authorization shape as the other cron endpoints: bearer CRON_SECRET,
 * failing closed when unset. The scan is read-only in this stage — it never
 * calls a provider and never changes financial state.
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
    const report = await runReconciliationScan();

    return NextResponse.json(report);
  } catch (error) {
    console.error("reconciliation scan failed", error);
    return NextResponse.json({ error: "Scan failed" }, { status: 500 });
  }
}
