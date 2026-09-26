import "server-only";

import { prisma } from "@/lib/prisma";
import { getSupportActor } from "@/lib/authz";
import {
  transitionObligation,
  transitionEventKey,
} from "@/services/payments/obligation-state.service";

/**
 * Stage 13A §11 — dispute freeze overlay (the seam only, no dispute system).
 *
 * Engaging the freeze flips `dispute` on the obligation; the state machine
 * then refuses every transition into RELEASED/REFUNDED, so a disputed
 * obligation can never settle or refund automatically. Lifting the freeze is
 * an explicit admin act too — nothing auto-resolves.
 *
 * Authorization (HARDENED in Stage 14D):
 *   `assertAuthorizedAdmin` used to accept any actor with
 *   `authenticated: true` — authentication alone. It now requires REAL
 *   Support authorization: the caller must hold a server session with the
 *   SUPPORT role AND be on the operator-maintained support roster (the same
 *   fail-closed contract as the milestone support-decision path). A merely
 *   authenticated creator/advertiser actor is refused — the flag alone can
 *   never authorize anything.
 *   The financial act is re-checked in the SERVICE (defense in depth): a
 *   future caller that only forwards a session must still be a rostered
 *   SUPPORT operator to move the freeze. `assertSupportAuthorized` also
 *   remains available for routes/actions that want to pre-check.
 */

export type DisputeActionResult =
  | { ok: true; obligationId: string; frozen: boolean }
  | { ok: false; code: "NOT_FOUND" | "UNAUTHORIZED"; reason: string };

/**
 * Contract for the authenticated actor performing an admin financial action.
 * `authenticated: true` must come from a real session check in the calling
 * route/action — never from client input.
 */
export type AdminActor = {
  authenticated: boolean;
  userId: string;
  source: string;
};

/**
 * Stage 14D — the REAL Support authorization check behind every dispute
 * action. Two requirements, BOTH enforced against server-side facts:
 *   1. the caller's own server session carries the SUPPORT role; and
 *   2. that same session user is on the operator-maintained support roster.
 * Fail-closed: no session, wrong role, or absent roster → refused. An empty
 * roster authorizes nobody.
 */
async function isAuthorizedSupportOperator(userId: string): Promise<boolean> {
  if (!userId) {
    return false;
  }

  // (1) Fresh server-side identity + role (never a client-supplied value):
  // the ONLY accepted session is the caller's own.
  const session = await getSupportActor();

  if (!session || session.id !== userId) {
    return false;
  }

  // (2) Fresh-DB roster membership (getSupportActor already re-read it —
  // this re-check keeps the invariant explicit and survives future edits).
  const roster = await prisma.user.findUnique({
    where: { id: userId },
    select: { supportRosterMember: true },
  });

  return roster?.supportRosterMember === true;
}

export class DisputeAuthorizationError extends Error {
  constructor(message = "Support authorization required.") {
    super(message);
    this.name = "DisputeAuthorizationError";
  }
}

/**
 * Non-throwing check for callers that want a verdict (actions, tests):
 * true only for a currently rostered SUPPORT session user.
 */
export async function assertSupportAuthorized(actor: AdminActor): Promise<boolean> {
  return isAuthorizedSupportOperator(actor.userId);
}

/**
 * HARDENED Stage 14D gate — NEVER authorizes on `authenticated === true`
 * alone. The flag is still required (an unauthenticated actor is refused
 * outright), but the decisive check is the real Support authorization
 * contract: SUPPORT role + roster, verified against the server session.
 */
async function assertAuthorizedAdmin(actor: AdminActor): Promise<void> {
  if (!actor.authenticated) {
    throw new DisputeAuthorizationError("Actor is not authenticated.");
  }

  if (!(await isAuthorizedSupportOperator(actor.userId))) {
    throw new DisputeAuthorizationError("Support authorization required.");
  }
}

/**
 * Engage or lift the dispute freeze with a conditional update (only a row in
 * the expected freeze state matches, so double-actions are no-ops) and write
 * an auditable financial event (dispute_opened / dispute_resolved).
 */
export async function setDisputeFreeze(
  obligationId: string,
  freeze: boolean,
  actor: AdminActor,
  reason?: string,
): Promise<DisputeActionResult> {
  await assertAuthorizedAdmin(actor);

  const obligation = await prisma.financialObligation.findUnique({
    where: { id: obligationId },
    select: { id: true, dispute: true, status: true },
  });

  if (!obligation) {
    return { ok: false, code: "NOT_FOUND", reason: "Obligation not found." };
  }

  if (obligation.dispute === freeze) {
    // Idempotent: the requested freeze state is already in force.
    return { ok: true, obligationId, frozen: freeze };
  }

  const updated = await prisma.financialObligation.updateMany({
    where: { id: obligationId, dispute: !freeze },
    data: {
      dispute: freeze,
      disputeReason: freeze ? (reason ?? null) : null,
    },
  });

  if (updated.count === 0) {
    // A concurrent admin action already flipped it — treat as idempotent.
    return { ok: true, obligationId, frozen: freeze };
  }

  await prisma.financialEvent.create({
    data: {
      obligationId,
      agreementId: (
        await prisma.financialObligation.findUnique({
          where: { id: obligationId },
          select: { agreementId: true },
        })
      )?.agreementId as string,
      eventType: freeze ? "dispute_opened" : "dispute_resolved",
      actor: "ADMIN",
      actorId: actor.userId,
      source: actor.source,
      metadata: {
        frozen: freeze,
        reason: reason ?? null,
        // State stays untouched by the freeze itself — it is an overlay.
        statusAtFreeze: obligation.status,
      },
      idempotencyKey: `${transitionEventKey(obligationId, freeze ? ("dispute_opened" as never) : ("dispute_resolved" as never))}:${freeze}`,
    },
  });

  return { ok: true, obligationId, frozen: freeze };
}

/**
 * An authenticated user action that must pass through the state machine
 * (which enforces the freeze). Provided as the single sanctioned entry point
 * for moving a disputed obligation AFTER an admin resolution — the machine
 * itself still validates the edge.
 *
 * Stage 14D: the caller must be a REAL rostered SUPPORT operator (see
 * assertAuthorizedAdmin) — previously this accepted any ADMIN-flagged
 * request without verifying who was acting.
 */
export async function adminTransition(request: Parameters<typeof transitionObligation>[0]) {
  await assertAuthorizedAdmin({
    authenticated: request.actor === "ADMIN",
    userId: request.actorId ?? "",
    source: request.source,
  });

  return transitionObligation(request);
}
