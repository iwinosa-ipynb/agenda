import "server-only";

import { prisma } from "@/lib/prisma";
import { getPaymentProvider } from "@/services/payments/index";
import {
  transitionObligation,
  transitionEventKey,
} from "@/services/payments/obligation-state.service";
import { getSupportActor } from "@/lib/authz";
import type { AdminActor } from "@/services/payments/dispute.service";

/**
 * Stage 14E — refund execution (full refunds ONLY; no partial refunds).
 *
 * AUTHORIZATION (the 14D boundary, unchanged and unweakened):
 *   - The actor is resolved SERVER-SIDE ONLY: `getSupportActor()` returns the
 *     session user when and only when the live server session carries the
 *     SUPPORT role AND that user is on the operator-maintained support roster
 *     (fresh-DB check on every call). A client can never supply the identity:
 *     `actor.userId` supplied by a caller must be the CALLER'S OWN session id
 *     (identity match, same contract as dispute.service's hardening) and is
 *     never taken from FormData/client input by any sanctioned caller.
 *   - The authorized actor is re-derived here (not trusted from the caller):
 *     `assertSupportRefundAuthorized()` re-runs the full SUPPORT+roster check
 *     and the session-id match, so a future caller that only forwards a
 *     session is still gated (defense in depth, mirroring dispute.service).
 *   - `AdminActor.authenticated` is additionally required — an unauthenticated
 *     actor is refused outright (same first gate as dispute.service).
 *
 * SCOPE (product decision):
 *   - FULL refunds only. The refund amount is EXACTLY the frozen
 *     `advertiserTotalMinor`; no partial amount is ever accepted.
 *   - No refund UI; the service is the sanctioned execution layer.
 *
 * SAFETY GATES (all hard blocks, in order):
 *   1. authorization (above);
 *   2. provider configured;
 *   3. obligation exists and carries the funded payment's provider reference
 *      (without it the refund could not be aimed at the original charge);
 *   4. state: FUNDED or SETTLEMENT_PENDING (a settlement requested but not
 *      yet completed may still be reversed into a full refund) — or
 *      REFUND_PENDING, which is the RETRY path for an outstanding execution
 *      (provider outcome pending/ambiguous from an earlier attempt);
 *   5. no dispute freeze (the freeze overlay refuses REFUNDED; the operator
 *      must explicitly unfreeze via setDisputeFreeze first — never bypassed);
 *   6. no settled milestone: any milestone of the agreement in
 *      SETTLEMENT_PENDING or RELEASED blocks the refund (settled milestones
 *      already credit creator receivables/platform fees — a refund would
 *      over-refund);
 *   7. no in-flight provider transfer: any PENDING/REQUIRES_ACTION payout
 *      attempt (PaymentProviderTransaction with a milestone scope) on the
 *      obligation blocks the refund.
 *
 * FLOW:
 *   FUNDED/SETTLEMENT_PENDING → REFUND_PENDING (cause: refund_requested)
 *   → attempt row claimed (unique (provider, providerReference) = the claim)
 *   → IF the attempt was already POSTed provider-side (posted marker or a
 *     persisted Paystack refund id): RECONCILE FIRST via provider.getRefundStatus
 *     (GET /refund/:id, fallback GET /refund?transaction=...) —
 *       - processed → finalize locally EXACTLY ONCE (idempotent completion);
 *       - pending/processing → stay REFUND_PENDING, NO new POST;
 *       - provider confirms no live refund → audit + exactly ONE fresh POST;
 *       - lookup failure (unknown) → FAIL CLOSED: no POST, retry later;
 *   → ELSE (fresh attempt, provider has confirmed no live refund):
 *     provider.createRefund (exact frozen amount, deterministic reference)
 *       - posted marker + Paystack refund id (data.id) persisted BEFORE any
 *         local finalization, so a crash mid-completion reconciles on retry;
 *       - processed → REFUND_PENDING → REFUNDED (cause: refund_completed) with
 *         the three compensating REFUND ledger lines;
 *       - pending / timeout / network uncertainty → stays REFUND_PENDING;
 *         the next call RECONCILES (never blindly re-POSTs);
 *       - failed → NOT marked REFUNDED and NOT silently reverted: the
 *         obligation remains in REFUND_PENDING with an explicit audited event
 *         (admin_adjustment / kind:"refunds_failed" — no fake success, no
 *         invented state edge).
 *
 * WHY RECONCILE-FIRST: Paystack's POST /refund accepts NO client reference
 * and is therefore NOT idempotent — the deterministic `ref-<obligationId>`
 * reaches Paystack only as merchant_note free text. A second POST after an
 * accepted-but-unconfirmed refund could double-refund; the provider's own
 * status endpoint is the only safe arbiter (mirrors the payout pattern:
 * transfers are settled by getTransferStatus, never re-POSTed).
 *
 * IDEMPOTENCY (all existing mechanisms, nothing new):
 *   - deterministic refund reference `ref-<obligationId>` (attempt-row
 *     uniqueness + provider-facing merchant note);
 *   - deterministic event keys via transitionEventKey();
 *   - the conditional transition update is the row lock: a duplicate request
 *     either replays idempotently (same target state) or is refused as
 *     CONCURRENT_CONFLICT / INVALID_TRANSITION;
 *   - LedgerEntry.idempotencyKey / FinancialEvent.idempotencyKey uniques
 *     prevent duplicate accounting rows;
 *   - completion replays (REFUNDED already reached) return
 *     idempotentReplay: true without writing anything.
 */

export type RefundErrorCode =
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "PROVIDER_UNCONFIGURED"
  | "PROVIDER_REFERENCE_MISSING"
  | "INVALID_STATE"
  | "DISPUTE_FROZEN"
  | "MILESTONE_SETTLED"
  | "PAYOUT_IN_FLIGHT"
  | "PROVIDER_FAILED"
  | "TRANSITION_CONFLICT"
  | "RECONCILIATION_INCONCLUSIVE"
  | "TRANSIENT_DB_FAILURE";

export type RefundExecutionResult =
  | {
      ok: true;
      obligationId: string;
      /** REFUNDED when the provider confirmed processing; REFUND_PENDING otherwise. */
      status: "REFUNDED" | "REFUND_PENDING";
      refundReference: string;
      providerReference: string | null;
      /** Paystack's own refund id (data.id), when known. */
      providerRefundId: string | null;
      idempotentReplay: boolean;
    }
  | { ok: false; code: RefundErrorCode; reason: string };

/** Deterministic refund reference for one obligation (attempt-row dedupe). */
export function refundReferenceFor(obligationId: string): string {
  return `ref-${obligationId}`;
}

/**
 * Merge secret-free reconciliation context into the refund attempt row.
 * Best-effort: a failure here never blocks the outcome — the row is EVIDENCE,
 * and the posted marker is only relied upon by the retry path (which fails
 * closed on absence).
 */
async function recordAttemptMetadata(
  obligationId: string,
  refundReference: string,
  patch: { kind?: string; providerRefundId?: string },
): Promise<void> {
  const existing = await prisma.paymentProviderTransaction
    .findFirst({
      where: { providerReference: refundReference, provider: "paystack" },
    })
    .catch(() => null);

  const merged: Record<string, string> = {
    ...((typeof existing?.metadata === "object" &&
    existing?.metadata !== null
      ? existing.metadata
      : {}) as Record<string, string>),
  };

  if (patch.kind !== undefined) {
    merged.kind = patch.kind;
  }

  if (patch.providerRefundId !== undefined) {
    merged.providerRefundId = patch.providerRefundId;
  }

  await prisma.paymentProviderTransaction
    .updateMany({
      where: { obligationId, providerReference: refundReference, provider: "paystack" },
      data: { metadata: merged },
    })
    .catch(() => undefined);
}

/**
 * Finalize a provider-confirmed refund LOCALLY, exactly once.
 *
 * The completion is the conditional REFUND_PENDING → REFUNDED transition with
 * its deterministic event key and per-line ledger keys — the same machinery
 * the 13A executor enforces. A replay (already REFUNDED, or a concurrent
 * winner) returns idempotentReplay without writing a second event/ledger set.
 * INVALID_TRANSITION (e.g. a dispute freeze engaged between request and
 * completion) surfaces honestly: the provider HAS refunded, the state machine
 * refused — operator action, never a fabricated state.
 */
async function finalizeRefundCompletion(
  obligation: {
    id: string;
    agreementId: string;
    advertiserId: string;
    providerReference: string | null;
    creatorAmountMinor: bigint;
    platformFeeMinor: bigint;
    advertiserTotalMinor: bigint;
    currency: string;
  },
  refundReference: string,
  providerRefundId: string | null,
): Promise<RefundExecutionResult> {
  const completion = await transitionObligation({
    obligationId: obligation.id,
    from: "REFUND_PENDING",
    to: "REFUNDED",
    cause: "refund_completed",
    actor: "PROVIDER",
    actorId: null,
    source: "refund-service",
    idempotencyKey: transitionEventKey(obligation.id, "refund_completed"),
    providerReference: refundReference,
    // THE compensating ledger: exact inverse of the funding entries —
    // three lines, one transition, atomically, deterministic per-line keys
    // (`<eventKey>:<entryType>:<account>`).
    ledgerEntries: [
      {
        account: "platform:escrow",
        direction: "DEBIT",
        amountMinor: obligation.creatorAmountMinor,
        currency: obligation.currency,
        entryType: "REFUND",
        providerReference: refundReference,
      },
      {
        account: "platform:revenue",
        direction: "DEBIT",
        amountMinor: obligation.platformFeeMinor,
        currency: obligation.currency,
        entryType: "REFUND",
        providerReference: refundReference,
      },
      {
        account: `advertiser:${obligation.advertiserId}:payable`,
        direction: "CREDIT",
        amountMinor: obligation.advertiserTotalMinor,
        currency: obligation.currency,
        entryType: "REFUND",
        providerReference: refundReference,
      },
    ],
  });

  // Evidence row reflects only what the provider stated (never authority).
  await prisma.paymentProviderTransaction
    .updateMany({
      where: { providerReference: refundReference, provider: "paystack" },
      data: { providerStatus: "SUCCEEDED", confirmedAt: new Date() },
    })
    .catch(() => undefined);

  if (!completion.ok) {
    if (completion.code === "CONCURRENT_CONFLICT") {
      // A concurrent worker completed the refund — converge honestly.
      const current = await prisma.financialObligation.findUnique({
        where: { id: obligation.id },
        select: { status: true },
      });

      if (current?.status === "REFUNDED") {
        return {
          ok: true,
          obligationId: obligation.id,
          status: "REFUNDED",
          refundReference,
          providerReference: obligation.providerReference,
          providerRefundId,
          idempotentReplay: true,
        };
      }
    }

    // INVALID_TRANSITION (e.g. a dispute freeze engaged between request and
    // completion): the provider HAS processed the refund but the state
    // machine refused — surface this honestly for operator action rather
    // than pretending success or fabricating state.
    return {
      ok: false,
      code: "TRANSITION_CONFLICT",
      reason: `The provider processed the refund but the state transition was refused: ${completion.reason}`,
    };
  }

  return {
    ok: true,
    obligationId: obligation.id,
    status: "REFUNDED",
    refundReference,
    providerReference: obligation.providerReference,
    providerRefundId,
    idempotentReplay: completion.idempotentReplay,
  };
}

/**
 * Server-side authorization: the caller's own SUPPORT session, rostered and
 * matching the actor identity. Re-derives the 14D verdict rather than
 * trusting the caller. Fail-closed.
 */
async function assertSupportRefundAuthorized(actor: AdminActor): Promise<boolean> {
  if (!actor.authenticated) {
    return false;
  }

  // The full 14D verdict: session SUPPORT role + fresh-DB roster...
  const session = await getSupportActor();

  if (!session || session.id !== actor.userId) {
    return false;
  }

  // ...and a fresh roster re-read here (the dispute.service convention:
  // keep the service invariant explicit and resilient to future edits).
  const roster = await prisma.user.findUnique({
    where: { id: actor.userId },
    select: { supportRosterMember: true },
  });

  return roster?.supportRosterMember === true;
}

/**
 * Execute a FULL refund of a funded, unreleased obligation.
 *
 * `actor` must be built ONLY from the server session (the sanctioned caller
 * derives it via getSupportActor()); the service re-verifies both the actor's
 * identity match and the roster, so no client-controllable value can ever
 * influence authorization.
 */
export async function executeFullRefund(
  obligationId: string,
  actor: AdminActor,
  options: {
    /** Test seam ONLY: injects the provider (never exposed to actions). */
    providerOverride?: {
      createRefund: (request: {
        obligationId: string;
        providerReference: string;
        amountMinor: bigint;
        currency: string;
        reference: string;
      }) => Promise<{ status: "pending" | "processed" | "failed"; providerReference: string | null; reason?: string }>;
      /** Provider refund-status lookup (reconcile-before-re-post). */
      getRefundStatus: (request: {
        providerRefundId: string | null;
        chargeReference: string;
      }) => Promise<
        | { status: "pending" | "processed" | "failed"; providerRefundId: string | null }
        | { status: "unknown"; reason: string }
      >;
    };
  } = {},
): Promise<RefundExecutionResult> {
  // ---- 1. Authorization FIRST. ----
  if (!(await assertSupportRefundAuthorized(actor))) {
    return {
      ok: false,
      code: "UNAUTHORIZED",
      reason: "Support authorization required.",
    };
  }

  // ---- 2. Load the obligation (server-derived facts only). ----
  const obligation = await prisma.financialObligation.findUnique({
    where: { id: obligationId },
    select: {
      id: true,
      agreementId: true,
      advertiserId: true,
      status: true,
      dispute: true,
      escrowFunded: true,
      providerReference: true,
      creatorAmountMinor: true,
      platformFeeMinor: true,
      advertiserTotalMinor: true,
      currency: true,
    },
  });

  if (!obligation) {
    return { ok: false, code: "NOT_FOUND", reason: "Obligation not found." };
  }

  // ---- 3. Provider configured. ----
  const provider =
    options.providerOverride ??
    (() => {
      try {
        return getPaymentProvider();
      } catch {
        return null;
      }
    })();

  if (!provider) {
    return {
      ok: false,
      code: "PROVIDER_UNCONFIGURED",
      reason: "No payment provider is configured yet.",
    };
  }

  // ---- 4. The funded charge must be aimable. ----
  if (
    typeof obligation.providerReference !== "string" ||
    obligation.providerReference.length === 0
  ) {
    return {
      ok: false,
      code: "PROVIDER_REFERENCE_MISSING",
      reason: "The obligation has no provider charge reference to refund against.",
    };
  }

  // ---- 5. State gate: refund-requestable states only. REFUND_PENDING is
  // the RETRY entry (an outstanding execution converges; nothing re-enters
  // the terminal REFUNDED state — that is refused here). ----
  if (
    obligation.status !== "FUNDED" &&
    obligation.status !== "SETTLEMENT_PENDING" &&
    obligation.status !== "REFUND_PENDING"
  ) {
    return {
      ok: false,
      code: "INVALID_STATE",
      reason: `The obligation is ${obligation.status} — only a funded, unreleased payment can be refunded.`,
    };
  }

  // ---- 6. Dispute freeze: never bypassed. ----
  if (obligation.dispute) {
    return {
      ok: false,
      code: "DISPUTE_FROZEN",
      reason:
        "The funds are under a dispute freeze — lift the freeze explicitly before refunding.",
    };
  }

  // ---- 7. No settled/releasing milestone may exist (full-refund guard). ----
  const settledMilestones = await prisma.milestone.count({
    where: {
      agreementId: obligation.agreementId,
      status: { in: ["SETTLEMENT_PENDING", "RELEASED"] },
    },
  });

  if (settledMilestones > 0) {
    return {
      ok: false,
      code: "MILESTONE_SETTLED",
      reason:
        "A milestone of this agreement has already been settled or released — full refund refused.",
    };
  }

  // ---- 8. No in-flight payout/transfer attempt. ----
  const inFlightPayout = await prisma.paymentProviderTransaction.findFirst({
    where: {
      obligationId: obligation.id,
      milestoneId: { not: null },
      providerStatus: { in: ["PENDING", "REQUIRES_ACTION"] },
    },
  });

  if (inFlightPayout) {
    return {
      ok: false,
      code: "PAYOUT_IN_FLIGHT",
      reason: "A payout transfer is currently in flight — refund refused.",
    };
  }

  // ---- 9. Claim the → REFUND_PENDING edge (skipped on the retry path). ----
  const wasAlreadyPending = obligation.status === "REFUND_PENDING";

  if (!wasAlreadyPending) {
    const requestTransition = await transitionObligation({
      obligationId: obligation.id,
      from: obligation.status,
      to: "REFUND_PENDING",
      cause: "refund_requested",
      actor: "ADMIN",
      actorId: actor.userId,
      source: "refund-service",
      idempotencyKey: transitionEventKey(obligation.id, "refund_requested"),
    });

    if (!requestTransition.ok) {
      if (requestTransition.code === "CONCURRENT_CONFLICT") {
        return {
          ok: false,
          code: "TRANSITION_CONFLICT",
          reason: "The obligation changed state concurrently — re-check before retrying.",
        };
      }

      // INVALID_TRANSITION / NOT_FOUND: the row moved out from under us.
      return {
        ok: false,
        code: "INVALID_STATE",
        reason: requestTransition.reason,
      };
    }
  }

  // ---- 10. Claim/locate the refund attempt row BEFORE any provider call.
  // The unique (provider, providerReference) row is the attempt claim. ----
  const refundReference = refundReferenceFor(obligation.id);

  const existingAttempt = await prisma.paymentProviderTransaction.findFirst({
    where: { obligationId: obligation.id, providerReference: refundReference, provider: "paystack" },
  });

  const attemptMetadata = (
    typeof existingAttempt?.metadata === "object" && existingAttempt.metadata !== null
      ? existingAttempt.metadata
      : {}
  ) as {
    kind?: string;
    chargeReference?: string;
    providerRefundId?: string;
  };

  const persistedRefundId =
    typeof attemptMetadata.providerRefundId === "string" &&
    attemptMetadata.providerRefundId.length > 0
      ? attemptMetadata.providerRefundId
      : null;

  // "refund_posted" marks that POST /refund was ATTEMPTED for this row —
  // set BEFORE any local finalization, so a crash mid-completion lands here
  // on retry and reconciles instead of re-POSTing.
  const wasPosted = attemptMetadata.kind === "refund_posted" || persistedRefundId !== null;

  // ---- 10b. RETRY / ADOPTION: an attempt row already predates THIS call —
  // reconcile before anything else (14E safety fix; the old code fell
  // through to a blind second POST /refund here). The status lookup is a
  // safe GET: for a crashed prior attempt the provider truth is the only
  // arbiter; for a still-running claimant the lookup answers "pending" and
  // we simply replay without touching anything. ----
  if (existingAttempt) {
    if (wasPosted) {
      const lookup = await provider.getRefundStatus({
        providerRefundId: persistedRefundId,
        chargeReference: obligation.providerReference,
      });

      if (lookup.status === "unknown") {
        // Unanswerable lookup: fail closed. Never re-POST past an uncertainty.
        return {
          ok: false,
          code: "RECONCILIATION_INCONCLUSIVE",
          reason: "The provider's refund status could not be confirmed — the refund stays pending; retry reconciliation later.",
        };
      }

      if (lookup.status === "pending") {
        // In flight provider-side. Mark the attempt posted (an adopted row
        // may lack the marker), persist any newly-learned refund id, refresh
        // the evidence row, and stay REFUND_PENDING. No new POST.
        const patch: { kind: string; providerRefundId?: string } = {
          kind: "refund_posted",
        };

        if (lookup.providerRefundId !== null && lookup.providerRefundId !== persistedRefundId) {
          patch.providerRefundId = lookup.providerRefundId;
        }

        await recordAttemptMetadata(obligation.id, refundReference, patch);

        await prisma.paymentProviderTransaction
          .updateMany({
            where: { providerReference: refundReference, provider: "paystack" },
            data: { providerStatus: "PENDING" },
          })
          .catch(() => undefined);

        return {
          ok: true,
          obligationId: obligation.id,
          status: "REFUND_PENDING",
          refundReference,
          providerReference: obligation.providerReference,
          providerRefundId: lookup.providerRefundId,
          idempotentReplay: true,
        };
      }

      if (lookup.status === "failed") {
        // Provider confirms NO live refund (the refund definitively failed, or
        // the provider never received the request): audit the outcome and fall
        // through to the fresh POST below — EXACTLY ONE new POST, licensed by
        // the provider's own confirmation that none exists.
        await prisma.paymentProviderTransaction
          .updateMany({
            where: { providerReference: refundReference, provider: "paystack" },
            data: { providerStatus: "FAILED", confirmedAt: new Date() },
          })
          .catch(() => undefined);

        await prisma.financialEvent
          .create({
            data: {
              obligationId: obligation.id,
              agreementId: obligation.agreementId,
              eventType: "admin_adjustment",
              actor: "ADMIN",
              actorId: actor.userId,
              source: "refund-service",
              metadata: {
                kind: "refunds_failed",
                refundReference,
                chargeReference: obligation.providerReference,
                providerReason: "Provider reports no live refund (missing or failed).",
              },
              idempotencyKey: `evt:${obligation.id}:refund_failed`,
            },
          })
          .catch(() => undefined); // duplicate = already audited
      } else {
        // lookup.status === "processed": the provider HAS refunded. Persist
        // the learned refund id and finalize locally exactly once.
        if (lookup.providerRefundId !== null && lookup.providerRefundId !== persistedRefundId) {
          await recordAttemptMetadata(obligation.id, refundReference, {
            kind: "refund_posted",
            providerRefundId: lookup.providerRefundId,
          });
        }

        return finalizeRefundCompletion(obligation, refundReference, lookup.providerRefundId);
      }
    } else {
      // An UNPOSTED row predates this call: the prior call crashed AFTER
      // claiming the row but BEFORE its POST (or before the marker write).
      // The provider state is unknown, so reconcile through the lookup — a
      // GET is safe even for a live claimant. The provider's answer is
      // authoritative: processed → finalize; pending → stay; no refund →
      // exactly ONE fresh POST below.
      const lookup = await provider.getRefundStatus({
        providerRefundId: null,
        chargeReference: obligation.providerReference,
      });

      if (lookup.status === "unknown") {
        // Unanswerable lookup: fail closed. Nothing was proven; never POST.
        return {
          ok: false,
          code: "RECONCILIATION_INCONCLUSIVE",
          reason: "The provider's refund status could not be confirmed — the refund stays pending; retry reconciliation later.",
        };
      }

      if (lookup.status === "pending") {
        // The provider DOES have a refund in flight (the prior call posted
        // and crashed before its marker write). Persist the evidence and
        // stay REFUND_PENDING. No new POST.
        const patch: { kind: string; providerRefundId?: string } = {
          kind: "refund_posted",
        };

        if (lookup.providerRefundId !== null) {
          patch.providerRefundId = lookup.providerRefundId;
        }

        await recordAttemptMetadata(obligation.id, refundReference, patch);

        await prisma.paymentProviderTransaction
          .updateMany({
            where: { providerReference: refundReference, provider: "paystack" },
            data: { providerStatus: "PENDING" },
          })
          .catch(() => undefined);

        return {
          ok: true,
          obligationId: obligation.id,
          status: "REFUND_PENDING",
          refundReference,
          providerReference: obligation.providerReference,
          providerRefundId: lookup.providerRefundId,
          idempotentReplay: true,
        };
      }

      if (lookup.status === "processed") {
        // The prior call posted AND the provider already processed it while
        // we were away — persist the learned refund id and finalize locally
        // exactly once.
        if (lookup.providerRefundId !== null) {
          await recordAttemptMetadata(obligation.id, refundReference, {
            kind: "refund_posted",
            providerRefundId: lookup.providerRefundId,
          });
        }

        return finalizeRefundCompletion(obligation, refundReference, lookup.providerRefundId);
      }

      // lookup.status === "failed": the provider confirms NO live refund —
      // the prior call never landed. Fall through to the fresh POST below
      // (exactly ONE, licensed by the provider's own confirmation).
    }
  }

  // ---- 10c. Fresh claim (only when NO attempt row existed): create the
  // attempt row. A P2002 here means a caller raced us between findFirst and
  // create — treat it as an in-flight replay (fail closed: no POST from an
  // unprovable state). ----
  if (!existingAttempt) {
    try {
      await prisma.paymentProviderTransaction.create({
        data: {
          obligationId: obligation.id,
          // Null milestoneId: this is an obligation-level refund attempt —
          // the in-flight-payout gate keys on milestone-scoped rows.
          milestoneId: null,
          provider: "paystack",
          providerReference: refundReference,
          providerStatus: "PENDING",
          amountMinor: obligation.advertiserTotalMinor,
          currency: obligation.currency,
          metadata: {
            kind: "refund",
            chargeReference: obligation.providerReference,
          },
        },
      });
    } catch (error) {
      const isUniqueViolation =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "P2002";

      if (isUniqueViolation) {
        // A concurrent claimant created the row microseconds ago and may be
        // POSTing right now: the ONLY safe answer is to replay as in-flight —
        // never to POST a second refund on top of a possible first.
        return {
          ok: true,
          obligationId: obligation.id,
          status: "REFUND_PENDING",
          refundReference,
          providerReference: obligation.providerReference,
          providerRefundId: null,
          idempotentReplay: true,
        };
      }

      // DB outage before the provider call: nothing was claimed and NOTHING
      // was sent provider-side — fail closed. The obligation stays
      // REFUND_PENDING; a retry recreates the attempt row.
      console.error("paymentProviderTransaction.create (refund) failed", error);

      return {
        ok: false,
        code: "TRANSIENT_DB_FAILURE",
        reason: "The refund attempt could not be recorded — nothing was sent to the provider. Retry shortly.",
      };
    }
  }

  // ---- 12. Fresh POST — the attempt row was JUST created (no prior attempt
  // existed; nothing has ever been sent provider-side for this reference). ----
  const refund = await provider.createRefund({
    obligationId: obligation.id,
    providerReference: obligation.providerReference,
    amountMinor: obligation.advertiserTotalMinor,
    currency: obligation.currency,
    reference: refundReference,
  });

  // Persist what happened BEFORE any local finalization: the posted marker +
  // Paystack refund id are the handles a crashed retry reconciles through.
  const rawProviderRefundId = refund.providerReference ?? "";
  const providerRefundId = /^\d+$/.test(rawProviderRefundId) ? rawProviderRefundId : null;

  await recordAttemptMetadata(obligation.id, refundReference, {
    kind: refund.status === "failed" ? "refund_attempt_failed" : "refund_posted",
    ...(providerRefundId !== null ? { providerRefundId } : {}),
  });

  // Evidence row reflects only what the provider stated (never authority).
  await prisma.paymentProviderTransaction
    .updateMany({
      where: { providerReference: refundReference, provider: "paystack" },
      data: {
        providerStatus:
          refund.status === "processed"
            ? "SUCCEEDED"
            : refund.status === "failed"
              ? "FAILED"
              : "PENDING",
        confirmedAt: refund.status === "processed" ? new Date() : null,
      },
    })
    .catch(() => undefined);

  if (refund.status === "failed") {
    // NOT refunded. The obligation REMAINS in REFUND_PENDING (audited); no
    // fake success, no invented reverse edge. admin_adjustment is the
    // existing enum value for operator-recorded financial context.
    await prisma.financialEvent
      .create({
        data: {
          obligationId: obligation.id,
          agreementId: obligation.agreementId,
          eventType: "admin_adjustment",
          actor: "ADMIN",
          actorId: actor.userId,
          source: "refund-service",
          metadata: {
            kind: "refunds_failed",
            refundReference,
            chargeReference: obligation.providerReference,
            providerReason: refund.reason ?? null,
          },
          idempotencyKey: `evt:${obligation.id}:refund_failed`,
        },
      })
      .catch(() => undefined); // duplicate = already audited

    return {
      ok: false,
      code: "PROVIDER_FAILED",
      reason: refund.reason ?? "The provider refused the refund.",
    };
  }

  if (refund.status === "pending") {
    // Uncertainty/in-flight: stay REFUND_PENDING, never mark REFUNDED.
    return {
      ok: true,
      obligationId: obligation.id,
      status: "REFUND_PENDING",
      refundReference,
      providerReference: obligation.providerReference,
      providerRefundId,
      idempotentReplay: wasAlreadyPending,
    };
  }

  // ---- 13. Provider confirmed processing → complete the refund exactly
  // once (idempotent completion). ----
  return finalizeRefundCompletion(obligation, refundReference, providerRefundId);
}
