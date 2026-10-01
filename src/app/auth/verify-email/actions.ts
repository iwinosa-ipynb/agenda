"use server";

import { redirect } from "next/navigation";

import { requireUser } from "@/lib/authz";
import { isEmailConfigured } from "@/lib/email/email-service";
import {
  GENERIC_PENDING_MESSAGE,
  requestVerificationEmailForAddress,
} from "@/services/email-verification-account.service";
import { resendVerificationEmailForUser } from "@/services/email-verification.service";
import type { ActionResult } from "@/types";
import { emailSchema } from "@/validation/auth";
import { flattenFieldErrors } from "@/validation/errors";

/**
 * Resend-verification entry points (Stage 10).
 *
 * Two modes:
 *  - Signed in: operates on the session user; specific feedback is fine
 *    because the caller already knows their own account state.
 *  - Logged out: takes an email address and is enumeration-safe — identical
 *    generic response whether or not the address belongs to an account.
 *
 * Rate limiting (1/minute, 5/day) is enforced inside the services. Tokens
 * are never returned to the client in any mode.
 */

/**
 * Query-string flags the dashboard profile page renders as feedback after the
 * no-JavaScript resend redirect (see EmailVerificationStatus).
 */
export type VerificationResendStatus = "sent" | "error";

export async function resendVerificationAction(): Promise<ActionResult> {
  const user = await requireUser();

  const result = await resendVerificationEmailForUser({
    userId: user.id,
    email: user.email ?? "",
  });

  if (!result.success) {
    return { success: false, error: result.error };
  }

  if (!isEmailConfigured()) {
    // Explicit, operator-actionable message — never a fake success.
    return {
      success: false,
      error:
        "Email sending is not configured on this server yet (EMAIL_PROVIDER, BREVO_API_KEY, EMAIL_FROM_ADDRESS). No email was sent.",
    };
  }

  return { success: true, data: undefined };
}

/**
 * Progressive-enhancement variant of the resend: a full-page form POST with a
 * plain redirect outcome instead of useActionState state. Used by the
 * dashboard verification card so the resend still works — with visible
 * feedback via the query flag — when the app's JavaScript cannot run
 * (browsers below the supported baseline).
 */
export async function resendVerificationAndRedirectAction(
  formData: FormData,
): Promise<void> {
  const rawBackTo = formData.get("redirectTo");
  const backTo = typeof rawBackTo === "string" ? rawBackTo : "/dashboard/profile";
  const target = backTo.startsWith("/dashboard") ? backTo : "/dashboard/profile";

  const user = await requireUser();

  const result = await resendVerificationEmailForUser({
    userId: user.id,
    email: user.email ?? "",
  });

  if (result.success && isEmailConfigured()) {
    redirect(`${target}?verification=resend-sent`);
  }

  // Rate-limited, unknown user, or email not configured: one uniform,
  // operator-actionable failure surface.
  redirect(`${target}?verification=resend-failed`);
}

export async function requestVerificationForEmailAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = emailSchema.safeParse(formData.get("email"));

  if (!parsed.success) {
    // Deliberately generic: field-level validation errors do not reveal
    // anything about accounts, but we keep the reply uniform anyway.
    return {
      success: false,
      error: GENERIC_PENDING_MESSAGE,
      fieldErrors: flattenFieldErrors(parsed.error),
    };
  }

  await requestVerificationEmailForAddress(parsed.data);

  // ActionResult<undefined>: the generic message travels via `success` UI
  // state, not as data — it is rendered by the form itself.
  return { success: true, data: undefined };
}
