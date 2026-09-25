import "server-only";

import { Prisma } from "@/generated/prisma/client";

import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { prisma } from "@/lib/prisma";

/**
 * Stage 13A — webhook event storage + deduplication.
 *
 * Every delivery is STORED BEFORE any processing so duplicate and
 * out-of-order deliveries are safe: the unique (provider, providerEventId)
 * constraint makes a repeated delivery land on the existing row (dedupe) and
 * the caller must not process it twice. Malformed deliveries without an
 * event id are stored for audit but marked SKIPPED — they can never be
 * deduplicated safely, so they are never processed.
 *
 * Secrets (signature header values, provider keys) are never persisted —
 * only verification metadata.
 */

export type StoredWebhookEvent = {
  id: string;
  status: "RECEIVED" | "PROCESSING" | "PROCESSED" | "FAILED" | "SKIPPED";
  alreadyExisted: boolean;
};

export type StoreWebhookEventInput = {
  provider: string;
  providerEventId: string | null;
  eventType: string | null;
  payload: Record<string, unknown>;
  signatureMetadata?: {
    scheme: string;
    signed: boolean;
  } & Record<string, unknown>;
};

/**
 * Store a verified webhook delivery. Returns the stored row and whether it
 * was already present (duplicate) so the caller can skip reprocessing.
 */
export async function storeWebhookEvent(
  input: StoreWebhookEventInput,
): Promise<StoredWebhookEvent> {
  const shouldSkip = input.providerEventId === null;

  try {
    const created = await prisma.webhookEvent.create({
      data: {
        provider: input.provider,
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        payload: input.payload as Prisma.InputJsonValue,
        signatureMetadata:
          (input.signatureMetadata as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
        // No event id → cannot be deduplicated → never processed.
        status: shouldSkip ? "SKIPPED" : "RECEIVED",
      },
      select: { id: true, status: true },
    });

    return { id: created.id, status: created.status, alreadyExisted: false };
  } catch (error) {
    // Unique race: this exact (provider, providerEventId) was already
    // delivered. That IS the deduplication — report it, never reprocess.
    if (isUniqueConstraintError(error)) {
      const existing = await prisma.webhookEvent.findFirst({
        where: { provider: input.provider, providerEventId: input.providerEventId },
        select: { id: true, status: true },
      });

      if (existing) {
        return {
          id: existing.id,
          status: existing.status,
          alreadyExisted: true,
        };
      }
    }

    throw error;
  }
}

/**
 * Claim a stored event for processing with a conditional update — exactly one
 * concurrent worker can move RECEIVED → PROCESSING.
 */
export async function claimWebhookEventForProcessing(
  webhookEventId: string,
): Promise<boolean> {
  const claimed = await prisma.webhookEvent.updateMany({
    where: { id: webhookEventId, status: "RECEIVED" },
    data: { status: "PROCESSING" },
  });

  return claimed.count === 1;
}

/** Mark a claimed event processed (or failed) after the processing boundary. */
export async function completeWebhookEvent(
  webhookEventId: string,
  outcome: { ok: true } | { ok: false; error: string },
): Promise<void> {
  await prisma.webhookEvent.update({
    where: { id: webhookEventId },
    data: {
      status: outcome.ok ? "PROCESSED" : "FAILED",
      processedAt: new Date(),
      // Only safe, secret-free error text is ever persisted.
      processingError: outcome.ok ? null : outcome.error.slice(0, 500),
    },
  });
}
