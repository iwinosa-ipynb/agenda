import { NextResponse } from "next/server";

import { getPaymentProvider } from "@/services/payments";
import {
  claimWebhookEventForProcessing,
  completeWebhookEvent,
  storeWebhookEvent,
} from "@/services/payments/webhook-event.service";
import { processWebhookEvent } from "@/services/payments/webhook-processing.service";

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

  // 6-7. Stage 14B: the claimed event is processed through the verification
  // gate (server-side verifyTransaction — the payload is a hint, never the
  // authority). Tolerant paths (unknown reference, out-of-order, mismatch,
  // provider-unavailable) process the event WITHOUT changing money state and
  // still ack, so Paystack does not retry forever; failures are recorded on
  // the stored event for audit.
  try {
    const outcome = await processWebhookEvent(
      stored.id,
      verification.event.payload,
      verification.event.eventType,
    );

    await completeWebhookEvent(stored.id, { ok: true });

    return NextResponse.json(
      { received: true, processed: outcome.processed, note: outcome.note },
      { status: 202 },
    );
  } catch (error) {
    console.error("paystack webhook processing failed", error);

    // Mark FAILED so the delivery is auditable; Paystack will retry, and the
    // (provider, providerEventId) dedupe + claim lifecycle keep it safe.
    await completeWebhookEvent(stored.id, {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 500) : "processing error",
    });

    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}

function getPaymentProviderSafe() {
  try {
    return getPaymentProvider();
  } catch {
    // PaymentsNotImplementedError — dormant by design when unconfigured.
    return null;
  }
}
