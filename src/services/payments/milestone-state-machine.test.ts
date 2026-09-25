import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALLOWED_MILESTONE_TRANSITIONS,
  MILESTONE_STATES,
  MILESTONE_TERMINAL_STATES,
  TIMER_PAUSED_STATES,
  TIMER_RUNNING_STATES,
  checkMilestoneTransition,
  isMilestoneTerminalState,
  isTimerPausedState,
  isTimerRunningState,
  pausedSecondsBetween,
  resolveReviewWindowView,
  reviewWindowDeadline,
  REVIEW_WINDOW_MS,
  isMilestoneEarningState,
} from "@/services/payments/milestone-state-machine";

describe("Stage 13B — milestone state machine (pure)", () => {
  it("covers exactly the approved states", () => {
    assert.deepEqual(
      [...MILESTONE_STATES].sort(),
      [
        "CONFIRMED_RELEASE",
        "CORRECTION_REQUESTED",
        "PENDING",
        "PENDING_REVERIFICATION",
        "RELEASED",
        "SETTLEMENT_PENDING",
        "SUPPORT_REVIEW",
        "VALID_CANCELLATION",
        "VERIFIED_PENDING_REVIEW",
      ].sort(),
    );
  });

  it("allows the happy path PENDING → VERIFIED_PENDING_REVIEW → CONFIRMED_RELEASE → SETTLEMENT_PENDING → RELEASED", () => {
    assert.equal(checkMilestoneTransition("PENDING", "VERIFIED_PENDING_REVIEW").allowed, true);
    assert.equal(
      checkMilestoneTransition("VERIFIED_PENDING_REVIEW", "CONFIRMED_RELEASE").allowed,
      true,
    );
    assert.equal(checkMilestoneTransition("CONFIRMED_RELEASE", "SETTLEMENT_PENDING").allowed, true);
    assert.equal(checkMilestoneTransition("SETTLEMENT_PENDING", "RELEASED").allowed, true);
  });

  it("allows the correction branch VERIFIED_PENDING_REVIEW → CORRECTION_REQUESTED → PENDING_REVERIFICATION → VERIFIED_PENDING_REVIEW", () => {
    assert.equal(
      checkMilestoneTransition("VERIFIED_PENDING_REVIEW", "CORRECTION_REQUESTED").allowed,
      true,
    );
    assert.equal(
      checkMilestoneTransition("CORRECTION_REQUESTED", "PENDING_REVERIFICATION").allowed,
      true,
    );
    assert.equal(
      checkMilestoneTransition("PENDING_REVERIFICATION", "VERIFIED_PENDING_REVIEW").allowed,
      true,
    );
  });

  it("allows the support branch and all four support outcomes", () => {
    assert.equal(checkMilestoneTransition("VERIFIED_PENDING_REVIEW", "SUPPORT_REVIEW").allowed, true);
    assert.equal(checkMilestoneTransition("SUPPORT_REVIEW", "SETTLEMENT_PENDING").allowed, true);
    assert.equal(checkMilestoneTransition("SUPPORT_REVIEW", "CORRECTION_REQUESTED").allowed, true);
    assert.equal(checkMilestoneTransition("SUPPORT_REVIEW", "VALID_CANCELLATION").allowed, true);
    // FURTHER_REVIEW stays in place.
    assert.equal(checkMilestoneTransition("SUPPORT_REVIEW", "SUPPORT_REVIEW").allowed, true);
  });

  it("refuses forbidden edges (skipping confirmation, releasing from review, unfunded shortcuts)", () => {
    assert.equal(checkMilestoneTransition("PENDING", "CONFIRMED_RELEASE").allowed, false);
    assert.equal(checkMilestoneTransition("PENDING", "RELEASED").allowed, false);
    assert.equal(checkMilestoneTransition("VERIFIED_PENDING_REVIEW", "RELEASED").allowed, false);
    assert.equal(checkMilestoneTransition("VERIFIED_PENDING_REVIEW", "SETTLEMENT_PENDING").allowed, false);
    assert.equal(checkMilestoneTransition("CORRECTION_REQUESTED", "CONFIRMED_RELEASE").allowed, false);
    assert.equal(checkMilestoneTransition("RELEASED", "PENDING").allowed, false);
    assert.equal(checkMilestoneTransition("VALID_CANCELLATION", "VERIFIED_PENDING_REVIEW").allowed, false);
  });

  it("marks exactly RELEASED and VALID_CANCELLATION terminal", () => {
    assert.deepEqual([...MILESTONE_TERMINAL_STATES].sort(), ["RELEASED", "VALID_CANCELLATION"]);
    assert.equal(isMilestoneTerminalState("RELEASED"), true);
    assert.equal(isMilestoneTerminalState("VALID_CANCELLATION"), true);
    assert.equal(isMilestoneTerminalState("SETTLEMENT_PENDING"), false);
  });

  it("runs the timer only during advertiser review, paused during correction/re-verification/support", () => {
    assert.equal(isTimerRunningState("VERIFIED_PENDING_REVIEW"), true);
    assert.equal(isTimerRunningState("CONFIRMED_RELEASE"), true);
    assert.equal(isTimerPausedState("CORRECTION_REQUESTED"), true);
    assert.equal(isTimerPausedState("PENDING_REVERIFICATION"), true);
    assert.equal(isTimerPausedState("SUPPORT_REVIEW"), true);
    assert.equal(isTimerRunningState("CORRECTION_REQUESTED"), false);
    assert.equal(isTimerPausedState("VERIFIED_PENDING_REVIEW"), false);
  });

  it("computes a 24h deadline from the open time", () => {
    const opened = new Date("2026-09-24T10:00:00Z");
    const deadline = reviewWindowDeadline(opened);

    assert.equal(deadline.getTime() - opened.getTime(), REVIEW_WINDOW_MS);
    assert.equal(REVIEW_WINDOW_MS, 24 * 60 * 60 * 1000);
  });

  it("never resets the window on any non-reverification transition", () => {
    // Only verification edges open a window; nothing else may touch it.
    const nonWindowEdges = Object.entries(ALLOWED_MILESTONE_TRANSITIONS).flatMap(
      ([from, targets]) => targets.map((to) => ({ from, to })),
    );

    const windowEdges = nonWindowEdges.filter(
      ({ from, to }) =>
        to === "VERIFIED_PENDING_REVIEW" && from !== "PENDING" && from !== "PENDING_REVERIFICATION",
    );

    assert.deepEqual(windowEdges, []);
  });

  it("accumulates paused seconds for advertiser-delay accounting", () => {
    const pausedAt = new Date("2026-09-24T10:00:00Z");
    const resumedAt = new Date("2026-09-24T11:30:00Z");

    assert.equal(pausedSecondsBetween(pausedAt, resumedAt), 90 * 60);
    assert.equal(pausedSecondsBetween(resumedAt, pausedAt), 0);
  });

  it("reports overdue windows as informational only (no auto release semantics)", () => {
    const opened = new Date("2026-09-24T00:00:00Z");
    const deadline = reviewWindowDeadline(opened);
    const later = new Date(deadline.getTime() + 60_000);

    const view = resolveReviewWindowView({
      status: "VERIFIED_PENDING_REVIEW",
      reviewWindowOpenedAt: opened,
      reviewWindowDeadlineAt: deadline,
      reviewPausedAt: null,
      totalPausedSeconds: 0,
      now: later,
    });

    assert.equal(view.running, true);
    assert.equal(view.isOverdue, true);
  });

  it("earns fees ONLY in RELEASED — future and cancelled milestones never earn", () => {
    for (const state of MILESTONE_STATES) {
      const earns = isMilestoneEarningState(state);

      if (state === "RELEASED") {
        assert.equal(earns, true, `${state} must earn`);
      } else {
        assert.equal(earns, false, `${state} must not earn`);
      }
    }
  });

  it("keeps TIMER_RUNNING_STATES and TIMER_PAUSED_STATES disjoint", () => {
    for (const state of TIMER_RUNNING_STATES) {
      assert.equal(TIMER_PAUSED_STATES.includes(state), false);
    }
  });
});
