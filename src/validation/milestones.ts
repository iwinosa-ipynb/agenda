import { z } from "zod";

/**
 * Stage 13B — validation schemas for milestone actions.
 *
 * Deliberately MINIMAL, exactly like the 13A financial schemas: clients may
 * identify WHAT should happen (which milestone) and supply free-text reasons,
 * but may NEVER supply or influence any amount, fee, deadline, timer value or
 * status. All money comes from the frozen milestone row; all timing comes
 * from the server clock.
 */

/** Confirm & release payment (advertiser). No amount fields exist here. */
export const confirmMilestoneReleaseSchema = z.object({
  milestoneId: z.string().uuid("A valid milestone id is required."),
});

/** Request a correction (advertiser). Text only — never an amount. */
export const requestMilestoneCorrectionSchema = z.object({
  milestoneId: z.string().uuid("A valid milestone id is required."),
  note: z
    .string()
    .trim()
    .min(10, { message: "Describe the correction in at least 10 characters." })
    .max(2000, { message: "Keep the correction request under 2000 characters." }),
});

/** Submit a corrected post (creator). The post id is a reference only. */
export const submitMilestoneCorrectionSchema = z.object({
  milestoneId: z.string().uuid("A valid milestone id is required."),
  postId: z.string().uuid("A valid post id is required."),
});

/** Escalate to support (advertiser or creator). */
export const escalateMilestoneSchema = z.object({
  milestoneId: z.string().uuid("A valid milestone id is required."),
  reason: z
    .string()
    .trim()
    .min(10, { message: "Describe the issue in at least 10 characters." })
    .max(2000, { message: "Keep the escalation reason under 2000 characters." }),
});

/** Explicit support decision (authenticated support actor only). */
export const supportDecisionSchema = z.object({
  milestoneId: z.string().uuid("A valid milestone id is required."),
  decision: z.enum(["RELEASE_PAYMENT", "REQUEST_CORRECTION", "CANCEL_AFFECTED_WORK", "FURTHER_REVIEW"]),
  reason: z
    .string()
    .trim()
    .min(10, { message: "Provide a decision reason of at least 10 characters." })
    .max(2000, { message: "Keep the decision reason under 2000 characters." }),
  evidenceRefs: z.array(z.string().max(200)).max(20).optional(),
});

/**
 * One milestone's EXPLICIT terms (server-side planning path). Amounts are
 * NEVER derived by splitting the agreement total: every milestone carries
 * its own fixed-point amount, and the planner enforces that they reconcile
 * exactly to the frozen agreement amount.
 */
export const milestonePlanTermSchema = z.object({
  position: z.number().int().min(1).max(52),
  title: z.string().trim().max(200).optional(),
  deliverables: z.string().trim().max(4000).optional(),
  startDate: z.date().optional(),
  dueDate: z.date().optional(),
  // Fixed-point decimal string, e.g. "200000.00". Converted through the
  // 13A money boundary; never taken from a browser, budget or rate card.
  creatorAmount: z.string().regex(/^\d{1,13}(\.\d{1,2})?$/, {
    message: "Provide the milestone amount as a plain decimal with at most 2 decimal places.",
  }),
});

/** Plan milestones for an agreement (server/funding path). */
export const planMilestonesSchema = z.object({
  agreementId: z.string().uuid("A valid agreement id is required."),
  /**
   * Explicit milestone terms. Omitted for single-milestone agreements (the
   * milestone then covers the whole agreement amount — exact, not a split).
   */
  milestones: z.array(milestonePlanTermSchema).min(1).max(52).optional(),
});

export type ConfirmMilestoneReleaseInput = z.infer<typeof confirmMilestoneReleaseSchema>;
export type RequestMilestoneCorrectionInput = z.infer<typeof requestMilestoneCorrectionSchema>;
export type SubmitMilestoneCorrectionInput = z.infer<typeof submitMilestoneCorrectionSchema>;
export type EscalateMilestoneInput = z.infer<typeof escalateMilestoneSchema>;
export type SupportDecisionInput = z.infer<typeof supportDecisionSchema>;
export type MilestonePlanTermInput = z.infer<typeof milestonePlanTermSchema>;
export type PlanMilestonesInput = z.infer<typeof planMilestonesSchema>;
