"use server";

import { revalidatePath } from "next/cache";

import { getViewerCreator } from "@/services/creator.service";
import { savePayoutRecipient } from "@/services/payments/payout-recipient.service";
import { savePayoutRecipientSchema } from "@/validation/payouts";
import type { ActionResult } from "@/types";

/**
 * Stage 14C — creator-only payout recipient actions.
 *
 * Identity ALWAYS comes from the server session (requireRole redirects any
 * other role before any code runs). The client may submit BANK DETAILS only —
 * a recipient code is never accepted from a client: codes are created
 * server-side via the provider port and stored server-side.
 */

function actionError(error: string): ActionResult<undefined> {
  return { success: false, error };
}

export async function savePayoutRecipientAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const { profile } = await getViewerCreator();

  const parsed = savePayoutRecipientSchema.safeParse({
    accountNumber: formData.get("accountNumber"),
    bankCode: formData.get("bankCode"),
    accountName: formData.get("accountName"),
    currency: formData.get("currency") ?? "NGN",
  });

  if (!parsed.success) {
    return actionError(
      parsed.error.issues[0]?.message ?? "Please check the bank details.",
    );
  }

  const result = await savePayoutRecipient(profile.id, parsed.data);

  if (!result.ok) {
    return actionError(result.reason);
  }

  revalidatePath("/dashboard/profile");

  return { success: true, data: undefined };
}
