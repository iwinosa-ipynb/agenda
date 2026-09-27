import { z } from "zod";

/**
 * Stage 13A — validation schemas for financial operations.
 *
 * Deliberately MINIMAL: clients may identify WHAT should happen (which
 * agreement, which obligation) but may never supply or influence any amount,
 * fee, total or currency. Financial values are always derived server-side.
 */

/** Create (or idempotently fetch) the obligation for an agreement. */
export const createObligationSchema = z.object({
  agreementId: z.string().uuid("A valid agreement id is required."),
});

/**
 * Admin dispute-freeze control (Stage 13A §11 — the freeze seam only, no
 * dispute workflow UI). Authenticated admin-only when an admin architecture
 * exists; the service layer re-checks authorization.
 */
export const disputeFreezeSchema = z.object({
  obligationId: z.string().uuid("A valid obligation id is required."),
  freeze: z.boolean(),
  /** Short, secret-free operational note (audited in FinancialEvent). */
  reason: z.string().max(500).optional(),
});

/**
 * Stage 14E closeout — Support full-refund trigger. The client identifies
 * WHAT to refund and nothing else: no amount, status, provider reference or
 * actor field exists here, and the refund amount is always the frozen
 * advertiserTotalMinor derived server-side (full refunds only).
 */
export const supportObligationActionSchema = z.object({
  obligationId: z.string().uuid("A valid obligation id is required."),
});

export type CreateObligationInput = z.infer<typeof createObligationSchema>;
export type DisputeFreezeInput = z.infer<typeof disputeFreezeSchema>;
