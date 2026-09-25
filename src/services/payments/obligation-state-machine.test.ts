import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALLOWED_TRANSITIONS,
  checkTransition,
  OBLIGATION_STATES,
  TERMINAL_STATES,
} from "@/services/payments/obligation-state-machine";

/**
 * Stage 13A — state-machine table tests.
 *
 * Pins the approved lifecycle: allowed edges, rejection of invalid ones, the
 * disputed freeze, and terminal-state permanence.
 */

describe("obligation state machine", () => {
  it("exposes exactly the approved ten states", () => {
    assert.deepEqual([...OBLIGATION_STATES], [
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
    ]);
  });

  it("allows the happy path from creation to release", () => {
    assert.deepEqual(checkTransition("PENDING_PAYMENT", "PROCESSING", false), { allowed: true });
    assert.deepEqual(checkTransition("PROCESSING", "FUNDED", false), { allowed: true });
    assert.deepEqual(checkTransition("FUNDED", "SETTLEMENT_PENDING", false), { allowed: true });
    assert.deepEqual(checkTransition("SETTLEMENT_PENDING", "RELEASED", false), { allowed: true });
  });

  it("allows the refund path from FUNDED", () => {
    assert.deepEqual(checkTransition("FUNDED", "REFUND_PENDING", false), { allowed: true });
    assert.deepEqual(checkTransition("REFUND_PENDING", "REFUNDED", false), { allowed: true });
  });

  it("allows the dispute overlay edges", () => {
    assert.deepEqual(checkTransition("FUNDED", "DISPUTED", false), { allowed: true });
    assert.deepEqual(checkTransition("SETTLEMENT_PENDING", "DISPUTED", false), { allowed: true });
    assert.deepEqual(checkTransition("REFUND_PENDING", "DISPUTED", false), { allowed: true });
    // Admin resolution exits:
    assert.deepEqual(checkTransition("DISPUTED", "FUNDED", false), { allowed: true });
    assert.deepEqual(checkTransition("DISPUTED", "SETTLEMENT_PENDING", false), { allowed: true });
    assert.deepEqual(checkTransition("DISPUTED", "REFUND_PENDING", false), { allowed: true });
  });

  it("allows PENDING_PAYMENT/PROCESSING cancellation before funding", () => {
    assert.deepEqual(checkTransition("PENDING_PAYMENT", "CANCELLED", false), { allowed: true });
    assert.deepEqual(checkTransition("PROCESSING", "CANCELLED", false), { allowed: true });
  });

  it("rejects skipping states (e.g. PENDING_PAYMENT → FUNDED)", () => {
    const result = checkTransition("PENDING_PAYMENT", "FUNDED", false);

    assert.equal(result.allowed, false);
  });

  it("rejects transitions from terminal states", () => {
    for (const state of TERMINAL_STATES) {
      const result = checkTransition(state, "PENDING_PAYMENT", false);

      assert.equal(result.allowed, false, `${state} must be terminal`);
    }

    // Explicitly: RELEASED and REFUNDED never move again.
    for (const target of OBLIGATION_STATES) {
      assert.equal(checkTransition("RELEASED", target, false).allowed, false);
      assert.equal(checkTransition("REFUNDED", target, false).allowed, false);
    }
  });

  it("rejects no-op self transitions", () => {
    assert.equal(checkTransition("FUNDED", "FUNDED", false).allowed, false);
  });

  it("rejects fabricated states defensively", () => {
    const bogus = "SOMETHING_ELSE" as Parameters<typeof checkTransition>[0];

    assert.equal(checkTransition(bogus, "FUNDED", false).allowed, false);
  });

  describe("disputed freeze (§11)", () => {
    it("blocks RELEASED and REFUNDED while frozen", () => {
      assert.equal(checkTransition("SETTLEMENT_PENDING", "RELEASED", true).allowed, false);
      assert.equal(checkTransition("REFUND_PENDING", "REFUNDED", true).allowed, false);
    });

    it("blocks every direct path into the settlement/refund outcomes when frozen", () => {
      // Even edges that are normally allowed cannot land on the protected
      // outcomes while the freeze is engaged.
      for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
        for (const target of targets) {
          if (target === "RELEASED" || target === "REFUNDED") {
            const result = checkTransition(from as never, target, true);

            assert.equal(
              result.allowed,
              false,
              `frozen ${from} → ${target} must be blocked`,
            );
          }
        }
      }
    });

    it("still allows non-money-moving edges while frozen (admin exits)", () => {
      assert.equal(checkTransition("DISPUTED", "REFUND_PENDING", false).allowed, true);
      assert.equal(checkTransition("DISPUTED", "FUNDED", false).allowed, true);
    });
  });
});
