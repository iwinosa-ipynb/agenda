import "server-only";

import { prisma } from "@/lib/prisma";
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
 * Authorization: Agenda has no admin role yet (Stage 13A). This service is
 * therefore callable only from a future admin authorization boundary; it
 * accepts an explicit authenticated actor contract and logs who acted. When
 * the admin architecture exists (Stage 14+ per roadmap), wire requireRole
 * (or its successor) in front of these functions.
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

function assertAuthorizedAdmin(actor: AdminActor): void {
  if (!actor.authenticated) {
    throw new DisputeAuthorizationError("Actor is not authenticated.");
  }
}

export class DisputeAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisputeAuthorizationError";
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
  assertAuthorizedAdmin(actor);

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
 */
export function adminTransition(request: Parameters<typeof transitionObligation>[0]) {
  assertAuthorizedAdmin({
    authenticated: request.actor === "ADMIN",
    userId: request.actorId ?? "",
    source: request.source,
  });

  return transitionObligation(request);
}
