import { NextResponse } from "next/server";

import { getPaymentProvider } from "@/services/payments";
import {
  claimWebhookEventForProcessing,
  completeWebhookEvent,
  storeWebhookEvent,
} from "@/services/payments/webhook-event.service";

/**
 * Stage 13A — POST /api/webhooks/payments/paystack (ARCHITECTURE ONLY).
 *
 * The route establishes the correct pipeline but is DORMANT: with no
 * Paystack provider configured it rejects everything without weakening
 * verification. It never processes an unsigned event and never trusts a
 * client-side payment report.
 *
 * Pipeline (approved architecture):
 *   1. Read the RAW request body (signature checks use raw bytes).
 *   2. Verify the webhook signature via the provider port — fail closed when
 *      no provider/secret is configured.
 *   3. Reject unverified events (401/400) — never store/process them.
 *   4. Store the event (WebhookEvent) — duplicates dedupe on the unique
 *      (provider, providerEventId) constraint.
 *   5. Claim it for processing (conditional update, exactly-once).
 *   6. Return quickly (202); the processing boundary below is where Stage
 *      13B will attach verification-driven state transitions.
 *
 * Provider verification (server-side transaction verification) remains the
 * ONLY proof that can drive an obligation to FUNDED — webhook payloads are
 * treated as hints, never as proof of money.
 */

export async function POST(request: Request): Promise<Response> {
  // 1. Raw body first — signatures are computed over raw bytes.
  let rawBody: string;

  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: "Unreadable body" }, { status: 400 });
  }

  // 2-3. Signature verification via the provider port. Fails closed: when no
  // provider is configured (no secrets), every event is rejected here.
  const provider = getPaymentProviderSafe();

  if (!provider) {
    // Dormant mode: correct architecture, zero processing, no weakened path.
    return NextResponse.json(
      { error: "Payment provider not configured" },
      { status: 503 },
    );
  }

  const headers = Object.fromEntries(request.headers.entries());

  const verification = await provider.verifyWebhook({
    rawBody,
    headers,
  });

  if (!verification.verified) {
    // 401: the event is not authentic. Nothing is stored or processed.
    return NextResponse.json(
      { error: "Webhook verification failed" },
      { status: 401 },
    );
  }

  // 4. Store (dedup) — a repeated delivery returns the existing row.
  const stored = await storeWebhookEvent({
    provider: provider.name,
    providerEventId: verification.event.providerEventId,
    eventType: verification.event.eventType,
    payload: verification.event.payload,
    signatureMetadata: {
      scheme: "hmac-sha512",
      signed: true,
    },
  });

  if (stored.alreadyExisted) {
    // Duplicate delivery — acknowledge without reprocessing.
    return NextResponse.json({ received: true, duplicate: true }, { status: 200 });
  }

  if (stored.status === "SKIPPED") {
    // No usable event id: stored for audit, never processed.
    return NextResponse.json({ received: true, processed: false }, { status: 202 });
  }

  // 5. Claim for processing — exactly one worker wins.
  const claimed = await claimWebhookEventForProcessing(stored.id);

  if (!claimed) {
    return NextResponse.json({ received: true, duplicate: true }, { status: 200 });
  }

  // 6-7. Fast ack. Stage 13A interprets NO events and changes NO money state
  // here: the event is marked processed-with-no-op so nothing is left dangling,
  // and Stage 13B replaces this call with verification-driven transitions.
  await completeWebhookEvent(stored.id, { ok: true });

  return NextResponse.json({ received: true }, { status: 202 });
}

function getPaymentProviderSafe() {
  try {
    return getPaymentProvider();
  } catch {
    // PaymentsNotImplementedError — dormant by design when unconfigured.
    return null;
  }
}
