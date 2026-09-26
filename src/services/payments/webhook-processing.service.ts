import "server-only";

import { prisma } from "@/lib/prisma";
import { verifyAndSettleFunding } from "@/services/payments/funding-verification.service";
import { settlePayoutFromProviderEvidence } from "@/services/payments/payout.service";

/**
 * Stage 14B — webhook processing boundary.
 *
 * The route already guarantees: signature verified (fail closed), stored with
 * (provider, providerEventId) dedupe, claimed exactly-once (RECEIVED →
 * PROCESSING). This boundary replaces the Stage 13A no-op: a claimed event is
 * mapped to the verification gate — the payload is a HINT; server-side
 * verification of the reference is the AUTHORITY.
 *
 * The boundary is tolerant by design:
 *   - unknown/foreign reference → event processed, no transition (audited);
 *   - out-of-order success after FUNDED → verification is an idempotent
 *     replay (no second transition, no second ledger set);
 *   - failure event after FUNDED → the gate refuses (no FUNDED → FAILED
 *     edge) and the obligation stays FUNDED;
 *   - amount/currency mismatch in any payload → ignored (the payload amount
 *     is never read as authority); the verification re-read decides;
 *   - missing event id → route stores SKIPPED, this boundary never sees it.
 */

export type WebhookProcessingResult = {
  processed: boolean;
  note: string;
};

/** The Paystack event types the boundary reacts to. Others are audited only. */
const RELEVANT_EVENT_TYPES = new Set([
  "charge.success",
  "charge.failed",
  "transfer.success",
  "transfer.failed",
  "transfer.reversed",
]);

export async function processWebhookEvent(
  webhookEventId: string,
  payload: Record<string, unknown>,
  eventType: string | null,
): Promise<WebhookProcessingResult> {
  if (eventType === null || !RELEVANT_EVENT_TYPES.has(eventType)) {
    return { processed: true, note: `Event type ${eventType ?? "unknown"} requires no action.` };
  }

  const data = payload.data as Record<string, unknown> | undefined;

  // The payload's reference is a HINT used to locate the obligation or the
  // payout attempt; the payload's amount/status fields are never read as
  // authority. Transfer events settle ONLY through the verification gate or
  // the attempt's evidence handler below.
  const reference =
    typeof data?.reference === "string" && data.reference.length > 0
      ? data.reference
      : null;

  if (reference === null) {
    return { processed: true, note: "Event carries no usable reference — nothing to verify." };
  }

  // --- Stage 14C: transfer events → payout evidence handler. ---
  if (eventType.startsWith("transfer.")) {
    const outcome =
      eventType === "transfer.success"
        ? "success"
        : eventType === "transfer.failed"
          ? "failed"
          : "reversed";

    // The payload itself is not trusted: settlePayoutFromProviderEvidence
    // re-checks the attempt, its amount against the frozen milestone, and
    // its current status before writing anything. Unknown references mutate
    // nothing (tolerant, like every other path here).
    const settlement = await settlePayoutFromProviderEvidence(reference, outcome);

    return {
      processed: true,
      note: settlement.ok
        ? `Transfer event handled: ${settlement.note}`
        : `Transfer event not actionable: ${settlement.note}`,
    };
  }

  // The business reference sent to Paystack at initiation === obligationRef.
  const obligation = await prisma.financialObligation.findUnique({
    where: { obligationRef: reference },
    select: { id: true, status: true },
  });

  if (!obligation) {
    // Unknown/foreign reference: process the event (audit-complete), touch
    // nothing. Never an error — Paystack would retry forever on a 500.
    return {
      processed: true,
      note: "No obligation matches the event reference — no action taken.",
    };
  }

  // The verification gate is idempotent and re-checks amount/currency against
  // the frozen obligation; the webhook payload itself is never trusted.
  const outcome = await verifyAndSettleFunding(obligation.id);

  if (outcome.ok) {
    return {
      processed: true,
      note:
        outcome.status === "FUNDED"
          ? `Funding verified and settled (${outcome.idempotentReplay ? "idempotent replay" : "transitioned"}).`
          : "Provider definitively reported the payment failed — obligation marked FAILED.",
    };
  }

  // UNVERIFIED / mismatch / provider-unavailable: the event is processed
  // (200-class ack) but the obligation state is untouched by the payload —
  // reconciliation and later webhooks will retry verification.
  return {
    processed: true,
    note: `Verification did not settle funding (${outcome.code}) — obligation state unchanged.`,
  };
}
