import "server-only";

import { Prisma, type FinancialEventType } from "@/generated/prisma/client";

import { prisma } from "@/lib/prisma";
import { formatMajor } from "@/lib/money";
import {
  checkTransition,
  type ObligationState,
  type TransitionCause,
} from "@/services/payments/obligation-state-machine";

/**
 * Stage 13A — transactional executor for obligation state transitions.
 *
 * Every transition:
 *   1. runs inside one prisma.$transaction;
 *   2. re-reads the obligation FOR UPDATE (updateMany acts as the row lock);
 *   3. validates the edge against the pure state-machine table;
 *   4. performs a CONDITIONAL update (WHERE id = ... AND status = <from>) so
 *      two concurrent transitions cannot both win — the database is the
 *      arbiter, exactly like the Stage 9/12 idempotency approach;
 *   5. writes the FinancialEvent documenting WHY (idempotent by key);
 *   6. writes any ledger entries the cause requires (idempotent by key).
 *
 * Money is never "moved" by an invalid path: the executor refuses before any
 * write when the edge is not allowed or the dispute freeze is engaged.
 */

export type TransitionLedgerEntryInput = {
  account: string;
  direction: "DEBIT" | "CREDIT";
  amountMinor: bigint;
  currency: string;
  entryType:
    | "CHARGE"
    | "ESCROW_HOLD"
    | "PLATFORM_FEE"
    | "CREATOR_PAYOUT"
    | "REFUND"
    | "ADJUSTMENT"
    | "FEE_REFUND";
  providerReference?: string | null;
  metadata?: Prisma.InputJsonValue;
};

export type TransitionRequest = {
  obligationId: string;
  from: ObligationState;
  to: ObligationState;
  cause: TransitionCause;
  actor: "SYSTEM" | "ADVERTISER" | "CREATOR" | "ADMIN" | "PROVIDER";
  actorId?: string | null;
  source: string;
  /** Stable unit-of-work key: the event dedupes on it. */
  idempotencyKey: string;
  providerReference?: string | null;
  metadata?: Prisma.InputJsonValue;
  /** Ledger lines written atomically with the transition (may be empty). */
  ledgerEntries?: TransitionLedgerEntryInput[];
};

export type TransitionResult =
  | {
      ok: true;
      status: ObligationState;
      /** True when this call was a no-op replay of an already-applied transition. */
      idempotentReplay: boolean;
    }
  | { ok: false; code: "NOT_FOUND" | "INVALID_TRANSITION" | "CONCURRENT_CONFLICT"; reason: string };

/**
 * Deterministic event idempotency key for a transition — callers may use this
 * or supply their own stable key.
 */
export function transitionEventKey(
  obligationId: string,
  cause: TransitionCause,
): string {
  return `evt:${obligationId}:${cause}`;
}

export async function transitionObligation(
  request: TransitionRequest,
): Promise<TransitionResult> {
  try {
    const result = await prisma.$transaction(async (tx): Promise<TransitionResult> => {
      // Conditional update doubles as the row lock: only a row still in the
      // expected state matches, so a racing transition loses here.
      const updated = await tx.financialObligation.updateMany({
        where: { id: request.obligationId, status: request.from },
        data: {
          status: request.to,
          escrowFunded: request.to === "FUNDED" ? true : undefined,
        },
      });

      if (updated.count === 0) {
        // Either a replay of an already-applied transition (idempotent
        // success) or a genuine conflict/invalid state.
        const current = await tx.financialObligation.findUnique({
          where: { id: request.obligationId },
          select: { status: true, dispute: true },
        });

        if (!current) {
          return { ok: false as const, code: "NOT_FOUND" as const, reason: "Obligation not found." };
        }

        if (current.status === request.to) {
          return { ok: true as const, status: request.to, idempotentReplay: true };
        }

        const check = checkTransition(
          current.status as ObligationState,
          request.to,
          current.dispute,
        );

        return {
          ok: false as const,
          code: check.allowed ? "CONCURRENT_CONFLICT" : "INVALID_TRANSITION",
          reason: check.allowed
            ? `Obligation moved from ${request.from} concurrently (now ${current.status}).`
            : check.reason,
        };
      }

      // Row is locked and updated — re-read with the dispute flag.
      const locked = await tx.financialObligation.findUnique({
        where: { id: request.obligationId },
        select: { dispute: true, creatorAmountMinor: true, currency: true, agreementId: true },
      });

      if (!locked) {
        throw new Error("obligation vanished during transition");
      }

      const check = checkTransition(request.from, request.to, locked.dispute);

      if (!check.allowed) {
        // Throwing rolls the status update back — nothing is written.
        throw new TransitionRefusedError(check.reason);
      }

      await tx.financialEvent.create({
        data: {
          obligationId: request.obligationId,
          agreementId: locked.agreementId,
          eventType: causeToEventType(request.cause),
          actor: request.actor,
          actorId: request.actorId ?? null,
          source: request.source,
          metadata: {
            from: request.from,
            to: request.to,
            cause: request.cause,
            providerReference: request.providerReference ?? null,
            ...(request.metadata as Prisma.InputJsonObject | undefined) ?? {},
          },
          idempotencyKey: request.idempotencyKey,
        },
      });

      for (const entry of request.ledgerEntries ?? []) {
        await tx.ledgerEntry.create({
          data: {
            account: entry.account,
            direction: entry.direction,
            amountMinor: entry.amountMinor,
            currency: entry.currency,
            entryType: entry.entryType,
            agreementId: locked.agreementId,
            financialObligationId: request.obligationId,
            providerReference: entry.providerReference ?? request.providerReference ?? null,
            // Ledger lines of one transition share the event's key, with the
            // account making each line distinct.
            idempotencyKey: `${request.idempotencyKey}:${entry.entryType}:${entry.account}`,
            metadata: {
              obligationRef: request.obligationId,
              eventKey: request.idempotencyKey,
              ...(entry.metadata as Prisma.InputJsonObject | undefined) ?? {},
            },
          },
        });
      }

      return { ok: true as const, status: request.to, idempotentReplay: false };
    });

    return result;
  } catch (error) {
    if (error instanceof TransitionRefusedError) {
      return { ok: false, code: "INVALID_TRANSITION", reason: error.message };
    }

    throw error;
  }
}

/** Thrown inside the transaction to roll back a refused transition. */
export class TransitionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionRefusedError";
  }
}

/** Map a transition cause to its FinancialEventType enum value. */
function causeToEventType(cause: TransitionCause): FinancialEventType {
  return cause as FinancialEventType;
}

/** Human-readable amount helper for logs/UI (display only). */
export function describeMinor(amountMinor: bigint, currency: string): string {
  return `${formatMajor(amountMinor, currency)} ${currency}`;
}
