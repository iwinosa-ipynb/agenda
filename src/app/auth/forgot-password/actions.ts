"use server";

import type { ActionResult } from "@/types";
import { forgotPasswordSchema } from "@/validation/auth";
import { flattenFieldErrors } from "@/validation/errors";
import {
  requestPasswordResetForAddress,
} from "@/services/password-reset.service";

/**
 * Forgot-password entry point.
 *
 * Enumeration-safe: the same generic success message is returned whether or
 * not the address belongs to an account. Field-level validation errors are
 * surfaced (they reveal nothing about accounts); every other outcome —
 * unknown address, rate-limited, email provider down — collapses into the
 * identical generic confirmation so account existence never leaks. The
 * service logs the operator-relevant reason server-side.
 */
export async function forgotPasswordAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = forgotPasswordSchema.safeParse({
    email: formData.get("email"),
  });

  if (!parsed.success) {
    return {
      success: false,
      error: "Please check the highlighted fields.",
      fieldErrors: flattenFieldErrors(parsed.error),
    };
  }

  await requestPasswordResetForAddress(parsed.data.email);

  // ActionResult<undefined>: the generic message travels via `success` UI
  // state, not as data — it is rendered by the form itself.
  return { success: true, data: undefined };
}
