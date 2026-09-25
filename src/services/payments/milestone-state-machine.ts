/**
 * Stage 13B — pure milestone state machine (no I/O).
 *
 * Same convention as obligation-state-machine.ts: the transition table and
 * helpers here are unit-testable in isolation; the transactional executor
 * lives in milestone-review.service.ts.
 *
 * Approved lifecycle (locked Stage 13B rules):
 *
 *   PENDING → VERIFIED_PENDING_REVIEW       platform verification passed; the
 *                                           24h advertiser review window opens
 *   VERIFIED_PENDING_REVIEW → CONFIRMED_RELEASE   advertiser confirms release
 *   VERIFIED_PENDING_REVIEW → CORRECTION_REQUESTED normal correction path
 *                                           (NOT a dispute); window pauses
 *   CORRECTION_REQUESTED → PENDING_REVERIFICATION creator resubmitted
 *   PENDING_REVERIFICATION → VERIFIED_PENDING_REVIEW  verification passed
 *                                           again; a NEW 24h window opens
 *   VERIFIED_PENDING_REVIEW → SUPPORT_REVIEW      escalated; window pauses
 *   SUPPORT_REVIEW → SETTLEMENT_PENDING     support RELEASE_PAYMENT decision
 *   SUPPORT_REVIEW → CORRECTION_REQUESTED   support REQUEST_CORRECTION decision
 *   SUPPORT_REVIEW → VALID_CANCELLATION     support CANCEL_AFFECTED_WORK
 *   SUPPORT_REVIEW → SUPPORT_REVIEW         FURTHER_REVIEW stays (audited)
 *   CONFIRMED_RELEASE → SETTLEMENT_PENDING  settlement prepared
 *   SETTLEMENT_PENDING → RELEASED           settled through the 13A ledger
 *
 * There is NO automatic release: an expired review window never moves a
 * milestone, it only becomes evidence of advertiser delay.
 *
 * LOW VIEWS / LIKES / COMMENTS / IMPRESSIONS NEVER BLOCK anything in this
 * machine: payment is based on deliverable fulfillment, not social
 * performance. No metric input exists anywhere in this module.
 */

import type { MilestoneStatus } from "@/generated/prisma/client";

export const MILESTONE_STATES = [
  "PENDING",
  "VERIFIED_PENDING_REVIEW",
  "CORRECTION_REQUESTED",
  "PENDING_REVERIFICATION",
  "SUPPORT_REVIEW",
  "CONFIRMED_RELEASE",
  "SETTLEMENT_PENDING",
  "RELEASED",
  "VALID_CANCELLATION",
] as const satisfies readonly MilestoneStatus[];

export type MilestoneState = (typeof MILESTONE_STATES)[number];

/** States from which no exit is possible. */
export const MILESTONE_TERMINAL_STATES: readonly MilestoneState[] = [
  "RELEASED",
  "VALID_CANCELLATION",
];

/**
 * States where the 24h advertiser review timer is RUNNING. It pauses in every
 * other active state (correction / re-verification / support review) and
 * never applies to settled states.
 */
export const TIMER_RUNNING_STATES: readonly MilestoneState[] = [
  "VERIFIED_PENDING_REVIEW",
  "CONFIRMED_RELEASE",
];

/**
 * States where the advertiser review timer is PAUSED. Pausing is a property
 * of the state itself — a page refresh cannot influence it, and resuming
 * happens only through the transitions below.
 */
export const TIMER_PAUSED_STATES: readonly MilestoneState[] = [
  "PENDING",
  "CORRECTION_REQUESTED",
  "PENDING_REVERIFICATION",
  "SUPPORT_REVIEW",
];

export type MilestoneTransitionCause =
  | "verification_verified"
  | "correction_requested"
  | "correction_submitted"
  | "reverification_verified"
  | "advertiser_confirmed"
  | "settlement_requested"
  | "settlement_completed"
  | "escalated_support"
  | "support_decision"
  | "valid_cancellation";

/**
 * Allowed transitions: the ONLY edges the executor will attempt. Anything not
 * listed here is rejected before any database call.
 */
export const ALLOWED_MILESTONE_TRANSITIONS: Readonly<
  Record<MilestoneState, readonly MilestoneState[]>
> = {
  PENDING: ["VERIFIED_PENDING_REVIEW"],
  VERIFIED_PENDING_REVIEW: [
    "CONFIRMED_RELEASE",
    "CORRECTION_REQUESTED",
    "SUPPORT_REVIEW",
  ],
  CORRECTION_REQUESTED: ["PENDING_REVERIFICATION"],
  PENDING_REVERIFICATION: [
    "VERIFIED_PENDING_REVIEW",
    "CORRECTION_REQUESTED",
  ],
  SUPPORT_REVIEW: [
    "SETTLEMENT_PENDING",
    "CORRECTION_REQUESTED",
    "VALID_CANCELLATION",
    // FURTHER_REVIEW: stays in SUPPORT_REVIEW, recorded as an audited event.
    "SUPPORT_REVIEW",
  ],
  CONFIRMED_RELEASE: ["SETTLEMENT_PENDING"],
  SETTLEMENT_PENDING: ["RELEASED"],
  RELEASED: [],
  VALID_CANCELLATION: [],
};

/**
 * Edges that open a FRESH 24h advertiser review window (initial verification
 * and post-correction re-verification). Any other edge never resets the
 * window — and no client action can ever fabricate or move the deadline.
 */
export const REVIEW_WINDOW_OPENING_CAUSES: readonly MilestoneTransitionCause[] = [
  "verification_verified",
  "reverification_verified",
];

export type TransitionCheckResult =
  | { allowed: true; opensReviewWindow: boolean }
  | { allowed: false; reason: string };

export function checkMilestoneTransition(
  from: MilestoneState,
  to: MilestoneState,
): TransitionCheckResult {
  if (from === to && isMilestoneTerminalState(from)) {
    return {
      allowed: false,
      reason: `State ${from} is terminal — no transitions are allowed.`,
    };
  }

  const allowedTargets = ALLOWED_MILESTONE_TRANSITIONS[from];

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

  return {
    allowed: true,
    opensReviewWindow: REVIEW_WINDOW_OPENING_CAUSES.some(
      (cause) => cause === "verification_verified" || cause === "reverification_verified",
    ) && to === "VERIFIED_PENDING_REVIEW",
  };
}

export function isMilestoneTerminalState(state: MilestoneState): boolean {
  return MILESTONE_TERMINAL_STATES.includes(state);
}

export function isTimerRunningState(state: MilestoneState): boolean {
  return TIMER_RUNNING_STATES.includes(state);
}

export function isTimerPausedState(state: MilestoneState): boolean {
  return TIMER_PAUSED_STATES.includes(state);
}

// ---------------------------------------------------------------------------
// Review window math (server-side facts only — display + delay auditing)
// ---------------------------------------------------------------------------

export const REVIEW_WINDOW_HOURS = 24;
export const REVIEW_WINDOW_MS = REVIEW_WINDOW_HOURS * 60 * 60 * 1000;

/**
 * The deadline for a window opened at `openedAt`. Server-computed; the client
 * can never influence it.
 */
export function reviewWindowDeadline(openedAt: Date): Date {
  return new Date(openedAt.getTime() + REVIEW_WINDOW_MS);
}

/**
 * Seconds the advertiser effectively could NOT review during a pause that
 * lasted from `pausedAt` to `now` — accumulated into totalPausedSeconds for
 * advertiser-delay accountability. Never interpreted as creator lateness.
 */
export function pausedSecondsBetween(pausedAt: Date, now: Date): number {
  const elapsed = Math.max(0, now.getTime() - pausedAt.getTime());

  return Math.floor(elapsed / 1000);
}

/**
 * Resolved review-window presentation facts for UI. The timer is derived
 * ENTIRELY from stored server timestamps; nothing about it is client-writable
 * and refreshing the page can never reset it.
 *
 * `isOverdue` is informational only — an expired window NEVER triggers a
 * release (no auto-release exists in this stage).
 */
export type ReviewWindowView = {
  running: boolean;
  paused: boolean;
  openedAt: Date | null;
  deadlineAt: Date | null;
  pausedAt: Date | null;
  /** Stored accumulated pause time (advertiser delay accounting). */
  totalPausedSeconds: number;
  isOverdue: boolean;
};

export function resolveReviewWindowView(input: {
  status: MilestoneState;
  reviewWindowOpenedAt: Date | null;
  reviewWindowDeadlineAt: Date | null;
  reviewPausedAt: Date | null;
  totalPausedSeconds: number;
  now?: Date;
}): ReviewWindowView {
  const now = input.now ?? new Date();
  const running = isTimerRunningState(input.status);

  return {
    running,
    paused: !running,
    openedAt: input.reviewWindowOpenedAt,
    deadlineAt: input.reviewWindowDeadlineAt,
    pausedAt: input.reviewPausedAt,
    totalPausedSeconds: input.totalPausedSeconds,
    // Only meaningful while the window is actually running.
    isOverdue:
      running &&
      input.reviewWindowDeadlineAt !== null &&
      now.getTime() > input.reviewWindowDeadlineAt.getTime(),
  };
}

// ---------------------------------------------------------------------------
// Milestone earning math (Stage 13B fee rules)
// ---------------------------------------------------------------------------

/**
 * True only for states in which the milestone's fees are EARNED. Agenda's
 * 5% advertiser service fee and 10% creator commission become earned ONLY
 * when the corresponding milestone is completed/settled — future milestones
 * (PENDING and every pre-confirmation state) and validly-cancelled milestones
 * never generate Agenda revenue.
 */
export function isMilestoneEarningState(state: MilestoneState): boolean {
  return state === "RELEASED";
}
