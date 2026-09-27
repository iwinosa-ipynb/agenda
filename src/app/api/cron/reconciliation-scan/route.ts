import { NextResponse } from "next/server";

import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { runReconciliationScan } from "@/services/payments/reconciliation.service";

/**
 * Reconciliation scan endpoint.
 *
 * Authorization: bearer CRON_SECRET, failing closed when unset. The scan
 * re-verifies stuck PROCESSING funding obligations through the server-side
 * verification gate (never marks FAILED from staleness) and polls in-flight
 * payout attempts; anything the provider cannot yet resolve stays pending.
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
