"use server";

import { revalidatePath } from "next/cache";

import { getViewerAdvertiser } from "@/services/advertiser.service";
import { initiatePaymentForObligation } from "@/services/payments/payment-initiation.service";
import { configurePaystackProviderIfConfigured } from "@/services/payments/paystack.provider";
import type { ActionResult } from "@/types";

/**
 * Stage 14B — advertiser-only payment initiation.
 *
 * The ONLY client input is the obligation id. Amount (advertiserTotalMinor),
 * currency, the Paystack reference (obligationRef) and the target status are
 * all derived server-side from the frozen obligation. Identity comes from the
 * server session (requireRole redirects creators/anonymous before any code
 * runs), mirroring the Stage 14A funding actions.
 */

function actionError(
  error: string,
): ActionResult<{ redirectUrl: string }> {
  return { success: false, error };
}

export async function initiatePaymentAction(
  _prev: ActionResult<{ redirectUrl: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ redirectUrl: string }>> {
  const { profile } = await getViewerAdvertiser();

  const obligationId = formData.get("obligationId");

  if (typeof obligationId !== "string" || !obligationId) {
    return actionError("A valid payment reference is required.");
  }

  // Activate the provider when configured (no-op in dormant mode).
  configurePaystackProviderIfConfigured({
    resolveAdvertiserEmail: resolveAdvertiserEmailForPaystack,
  });

  const result = await initiatePaymentForObligation(obligationId, profile.id);

  if (!result.ok) {
    return actionError(result.reason);
  }

  revalidatePath("/dashboard/agreements");
  revalidatePath("/dashboard");

  return {
    success: true,
    data: { redirectUrl: result.redirectUrl },
  };
}

/**
 * Resolves the advertiser's account email server-side from their profile id
 * for the Paystack charge. Server-only data path — the client never supplies
 * the email.
 */
async function resolveAdvertiserEmailForPaystack(
  advertiserId: string,
): Promise<string | null> {
  const { prisma } = await import("@/lib/prisma");

  const profile = await prisma.advertiserProfile.findUnique({
    where: { id: advertiserId },
    select: { user: { select: { email: true } } },
  });

  return profile?.user.email ?? null;
}
