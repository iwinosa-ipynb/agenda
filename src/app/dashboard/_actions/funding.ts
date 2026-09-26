"use server";

import { revalidatePath } from "next/cache";

import { getViewerAdvertiser } from "@/services/advertiser.service";
import {
  prepareFundingForAgreement,
  getFundingPreparationForAdvertiser,
  getFundingStatusForAdvertiser,
} from "@/services/payments/funding.service";
import { prepareFundingSchema } from "@/validation/funding";
import type { ActionResult } from "@/types";

/**
 * Stage 14A — advertiser-only funding preparation.
 *
 * The creator can NEVER trigger funding preparation: identity comes from the
 * server session via getViewerAdvertiser() (requireRole redirects any other
 * role), and the service re-checks agreement ownership inside every query.
 * No amount or fee field is accepted from the client beyond the explicit
 * milestone terms (positions/titles/amounts) — the obligation's amounts still
 * derive from the frozen agreement through the 13A money boundary, and the
 * terms must reconcile EXACTLY in BigInt minor units on the server.
 */

function actionError(error: string): ActionResult<undefined> {
  return { success: false, error };
}

/**
 * Confirmation-step preview: the advertiser sees the EXACT frozen agreement
 * amount (and nothing else changes hands) before preparing. Advertiser-only —
 * requireRole redirects any other role before any data is touched.
 */
export async function getFundingPreviewAction(
  agreementId: string,
): Promise<{ agreedAmount: string; currency: string } | null> {
  const { profile } = await getViewerAdvertiser();

  return getFundingPreparationForAdvertiser(agreementId, profile.id);
}

/**
 * Post-preparation status read: the REAL obligation state (PENDING_PAYMENT =
 * awaiting provider funding — never presented as paid) plus the frozen
 * milestone breakdown. Advertiser-only, like every funding action.
 */
export async function getFundingStatusAction(agreementId: string) {
  const { profile } = await getViewerAdvertiser();

  return getFundingStatusForAdvertiser(agreementId, profile.id);
}

export async function prepareFundingAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  // Identity from the server session — a creator or anonymous caller is
  // redirected by requireRole before any validation or service code runs.
  const { profile } = await getViewerAdvertiser();

  const parsed = prepareFundingSchema.safeParse({
    agreementId: formData.get("agreementId"),
    milestones: parseMilestoneTerms(formData),
  });

  if (!parsed.success) {
    return actionError(
      parsed.error.issues[0]?.message ?? "Please check the milestone terms.",
    );
  }

  const result = await prepareFundingForAgreement(
    parsed.data.agreementId,
    profile.id,
    { milestones: parsed.data.milestones },
  );

  if (!result.ok) {
    return actionError(result.reason);
  }

  revalidatePath("/dashboard/agreements");
  revalidatePath("/dashboard");

  return { success: true, data: undefined };
}

/**
 * Parse the milestone-term rows posted by the funding form. Each row is
 * position_N, title_N, amount_N (+ optional deliverables_N). Amounts are
 * fixed-point strings validated by the schema; every financial derivation
 * still happens server-side.
 */
function parseMilestoneTerms(formData: FormData) {
  const rawCount = Number(formData.get("milestoneCount") ?? "0");

  if (!Number.isSafeInteger(rawCount) || rawCount < 1 || rawCount > 52) {
    return [];
  }

  const terms: Array<{
    position: number;
    title?: string;
    deliverables?: string;
    creatorAmount: string;
  }> = [];

  for (let position = 1; position <= rawCount; position += 1) {
    const amount = formData.get(`amount_${position}`);
    const title = formData.get(`title_${position}`);
    const deliverables = formData.get(`deliverables_${position}`);

    if (typeof amount !== "string" || amount.trim() === "") {
      return [];
    }

    terms.push({
      position,
      title: typeof title === "string" && title.trim() !== "" ? title : undefined,
      deliverables:
        typeof deliverables === "string" && deliverables.trim() !== ""
          ? deliverables
          : undefined,
      creatorAmount: amount.trim(),
    });
  }

  return terms;
}
