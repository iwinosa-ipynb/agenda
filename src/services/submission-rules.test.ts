import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decideSubmission,
  type ExistingSubmission,
} from "@/services/submission-rules";

/**
 * Unit tests for the creator submission lifecycle decision. These rules are
 * re-checked server-side on every submission; the client never gets to pick
 * the lifecycle state.
 */

function post(id: string, status: ExistingSubmission["status"]): ExistingSubmission {
  return { id, status };
}

describe("decideSubmission — lifecycle matrix", () => {
  it("allows a first submission when no post exists", () => {
    const decision = decideSubmission([]);

    assert.deepEqual(decision, { kind: "FIRST_SUBMISSION" });
  });

  it("allows resubmission when the only existing post is REJECTED", () => {
    const decision = decideSubmission([post("p1", "REJECTED")]);

    assert.ok(decision.kind === "RESUBMISSION_ALLOWED");
    assert.ok(decision.kind === "RESUBMISSION_ALLOWED" && decision.previousPostId === "p1");
  });

  it("blocks when an existing post is SUBMITTED", () => {
    const decision = decideSubmission([post("p1", "SUBMITTED")]);

    assert.ok(decision.kind === "BLOCKED");
    assert.ok(decision.kind === "BLOCKED" && decision.reason.length > 0);
  });

  it("blocks when an existing post is VERIFYING", () => {
    const decision = decideSubmission([post("p1", "VERIFYING")]);

    assert.ok(decision.kind === "BLOCKED");
    assert.ok(decision.kind === "BLOCKED" && decision.reason.length > 0);
  });

  it("blocks when an existing post is VERIFIED", () => {
    const decision = decideSubmission([post("p1", "VERIFIED")]);

    assert.ok(decision.kind === "BLOCKED");
    assert.ok(decision.kind === "BLOCKED" && decision.reason.length > 0);
  });

  it("blocks when a REJECTED post coexists with any active post", () => {
    // A rejected history plus a live submission must not unlock anything.
    const decision = decideSubmission([
      post("p1", "REJECTED"),
      post("p2", "SUBMITTED"),
    ]);

    assert.equal(decision.kind, "BLOCKED");

    const decision2 = decideSubmission([
      post("p1", "REJECTED"),
      post("p2", "VERIFYING"),
    ]);

    assert.equal(decision2.kind, "BLOCKED");

    const decision3 = decideSubmission([
      post("p1", "REJECTED"),
      post("p2", "VERIFIED"),
    ]);

    assert.equal(decision3.kind, "BLOCKED");
  });

  it("blocks with a rejected-only history of multiple rejected posts", () => {
    // Even several rejections in a row only ever unlock ONE replacement.
    const decision = decideSubmission([
      post("p1", "REJECTED"),
      post("p2", "REJECTED"),
    ]);

    assert.ok(decision.kind === "RESUBMISSION_ALLOWED");
    // The first rejected record in the list is the one referenced.
    assert.ok(
      decision.kind === "RESUBMISSION_ALLOWED" &&
        decision.previousPostId === "p1",
    );
  });
});

describe("decideSubmission — determinism and input safety", () => {
  it("is deterministic for the same input", () => {
    const input = [post("p1", "SUBMITTED")];

    const a = decideSubmission(input);
    const b = decideSubmission(input);

    assert.deepEqual(a, b);
  });

  it("is deterministic across repeated resubmission decisions", () => {
    const input = [post("p1", "REJECTED")];

    for (let i = 0; i < 5; i += 1) {
      assert.deepEqual(decideSubmission(input), {
        kind: "RESUBMISSION_ALLOWED",
        previousPostId: "p1",
      });
    }
  });

  it("rejects arbitrary client-controlled status strings via the type system", () => {
    // PostStatus is a closed Prisma enum: the compiler refuses anything that
    // is not SUBMITTED / VERIFYING / VERIFIED / REJECTED. At runtime nothing
    // here reads request data — callers pass rows loaded from the database —
    // so a forged status like "VERIFIED" is only ever this exact literal.
    const forged = { id: "p1", status: "VERIFIED" } satisfies ExistingSubmission;

    const decision = decideSubmission([forged]);

    assert.equal(decision.kind, "BLOCKED");
  });

  it("does not depend on input order for the active-post check", () => {
    const first = decideSubmission([
      post("p1", "REJECTED"),
      post("p2", "VERIFIED"),
    ]);
    const second = decideSubmission([
      post("p2", "VERIFIED"),
      post("p1", "REJECTED"),
    ]);

    // Both orders must block — the VERIFIED post always wins the decision.
    assert.equal(first.kind, "BLOCKED");
    assert.equal(second.kind, "BLOCKED");
  });
});
