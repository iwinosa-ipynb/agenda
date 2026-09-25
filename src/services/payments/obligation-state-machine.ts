/**
 * Stage 13A — pure financial-obligation state machine.
 *
 * No I/O here: the transition table and its helpers are unit-testable in
 * isolation (same convention as verified-views-accounting). The transactional
 * execution lives in obligation-state.service.ts.
 *
 * Transition semantics (approved architecture):
 *
 *   PENDING_PAYMENT → PROCESSING      payment initiated with provider
 *   PENDING_PAYMENT → CANCELLED       agreement cancelled before funding
 *   PROCESSING      → FUNDED          provider-verified charge held in escrow
 *   PROCESSING      → FAILED          provider reports definitive failure
 *   PROCESSING      → CANCELLED       abandoned before funding (rare)
 *   FUNDED          → SETTLEMENT_PENDING  release to creator requested
 *   FUNDED          → REFUND_PENDING  refund to advertiser requested
 *   FUNDED          → DISPUTED        dispute freeze overlay engaged
 *   SETTLEMENT_PENDING → RELEASED     creator amount settled (terminal)
 *   SETTLEMENT_PENDING → DISPUTED     frozen before payout
 *   REFUND_PENDING  → REFUNDED        advertiser amount returned (terminal)
 *   REFUND_PENDING  → DISPUTED        frozen before refund
 *   DISPUTED        → FUNDED          admin unfreezes (resume release path)
 *   DISPUTED        → REFUND_PENDING  admin resolves towards refund
 *   DISPUTED        → SETTLEMENT_PENDING  admin resolves towards release
 *
 * REFUND_PENDING may also be reached from SETTLEMENT_PENDING (operator
 * reverses a requested settlement before payout). RELEASED and REFUNDED are
 * terminal — no outgoing transitions. FAILED and CANCELLED are terminal for
 * this stage.
 *
 * DISPUTED is a FREEZE, not a settlement path: while `dispute` is set the
 * executor refuses every transition into RELEASED/REFUNDED regardless of
 * table membership, so a dispute can never resolve automatically.
 */

import type { FinancialObligationStatus } from "@/generated/prisma/client";

// The approved state list, in lifecycle order.
export const OBLIGATION_STATES = [
  "PENDING_PAYMENT",
  "PROCESSING",
  "FUNDED",
  "SETTLEMENT_PENDING",
  "RELEASED",
  "REFUND_PENDING",
  "REFUNDED",
  "FAILED",
  "DISPUTED",
  "CANCELLED",
] as const satisfies readonly FinancialObligationStatus[];

export type ObligationState = (typeof OBLIGATION_STATES)[number];

/** States from which no exit is possible. */
export const TERMINAL_STATES: readonly ObligationState[] = [
  "RELEASED",
  "REFUNDED",
  "FAILED",
  "CANCELLED",
];

/** States describing money actually held by the platform. */
export const FUNDED_STATES: readonly ObligationState[] = [
  "FUNDED",
  "SETTLEMENT_PENDING",
];

export type TransitionCause =
  | "payment_initiated"
  | "payment_verified"
  | "payment_failed"
  | "payment_abandoned"
  | "settlement_requested"
  | "settlement_completed"
  | "refund_requested"
  | "refund_completed"
  | "dispute_opened"
  | "dispute_resolved_release"
  | "dispute_resolved_refund"
  | "obligation_cancelled";

/**
 * Allowed transitions: the ONLY edges the executor will ever attempt. Anything
 * not listed here is an invalid transition and is rejected before any database
 * call is made.
 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<ObligationState, readonly ObligationState[]>
> = {
  PENDING_PAYMENT: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["FUNDED", "FAILED", "CANCELLED"],
  FUNDED: ["SETTLEMENT_PENDING", "REFUND_PENDING", "DISPUTED"],
  SETTLEMENT_PENDING: ["RELEASED", "DISPUTED", "REFUND_PENDING"],
  RELEASED: [],
  REFUND_PENDING: ["REFUNDED", "DISPUTED"],
  REFUNDED: [],
  FAILED: [],
  DISPUTED: ["FUNDED", "SETTLEMENT_PENDING", "REFUND_PENDING"],
  CANCELLED: [],
};

/** States the freeze overlay protects: disputed money cannot move on its own. */
const FREEZE_PROTECTED_TARGETS: readonly ObligationState[] = [
  "RELEASED",
  "REFUNDED",
];

export type TransitionCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Pure transition gate. `disputeFrozen` reflects the obligation's dispute
 * flag as read inside the transition transaction.
 */
export function checkTransition(
  from: ObligationState,
  to: ObligationState,
  disputeFrozen: boolean,
): TransitionCheckResult {
  if (from === to) {
    return {
      allowed: false,
      reason: `State ${from} is already the requested state.`,
    };
  }

  if (isTerminalState(from)) {
    return {
      allowed: false,
      reason: `State ${from} is terminal — no transitions are allowed.`,
    };
  }

  const allowedTargets = ALLOWED_TRANSITIONS[from];

  // Defensive: a state outside the approved table is always invalid.
  if (!allowedTargets) {
    return {
      allowed: false,
      reason: `Unknown state ${String(from)} — no transitions are allowed.`,
    };
  }

  if (!allowedTargets.includes(to)) {
    return {
      allowed: false,
      reason: `Transition ${from} → ${to} is not allowed.`,
    };
  }

  if (disputeFrozen && FREEZE_PROTECTED_TARGETS.includes(to)) {
    return {
      allowed: false,
      reason: `Obligation is DISPUTED-frozen; transition into ${to} is blocked.`,
    };
  }

  return { allowed: true };
}

export function isTerminalState(state: ObligationState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function isFundedState(state: ObligationState): boolean {
  return FUNDED_STATES.includes(state);
}

/** Which FinancialEventType documents a given transition cause. */
export function eventTypeForCause(cause: TransitionCause): string {
  return cause;
}
