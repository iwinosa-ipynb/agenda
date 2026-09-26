import { z } from "zod";

import { milestonePlanTermSchema } from "@/validation/milestones";

/**
 * Stage 14A — validation for the advertiser funding-preparation flow.
 *
 * Money discipline (unchanged from 13A/13B): the client may propose the
 * milestone STRUCTURE only — positions, titles, deliverables and each
 * milestone's fixed-point creator amount. Every financial value is still
 * derived server-side:
 *
 *   - the obligation's creator amount comes from the FROZEN agreement;
 *   - the funding fee comes from the ACTIVE PlatformFeeConfig row;
 *   - milestone amounts must reconcile EXACTLY to the agreement total
 *     (enforced by the 13B planner, in BigInt minor units);
 *   - zero/negative/duplicate/non-reconciling terms are refused.
 *
 * EXPLICIT TERMS ARE REQUIRED: this flow never auto-splits the agreement
 * amount. The UI always posts at least one milestone (defaulting to the
 * whole agreement amount as a single explicit milestone).
 */

/** The explicit terms the funding service receives (agreementId is separate). */
export const fundingMilestoneTermsSchema = z.object({
  milestones: z
    .array(milestonePlanTermSchema)
    .min(1, { message: "Define at least one milestone with its own amount." })
    .max(52, { message: "An agreement supports at most 52 milestones." }),
});

export const prepareFundingSchema = z.object({
  agreementId: z.string().uuid("A valid agreement id is required."),
  milestones: fundingMilestoneTermsSchema.shape.milestones,
});

export type PrepareFundingInput = z.infer<typeof fundingMilestoneTermsSchema>;
export type PrepareFundingActionInput = z.infer<typeof prepareFundingSchema>;
