"use server";

import type { ActionResult } from "@/types";
import { resetPasswordSchema } from "@/validation/auth";
import { flattenFieldErrors } from "@/validation/errors";
import { resetPasswordWithToken } from "@/services/password-reset.service";

/**
 * Password-reset entry point (token arrives via the page's query string and
 * is passed through by the form). The token is validated and consumed
 * server-side inside the service; it is never rendered, logged, or echoed.
 */
export async function resetPasswordAction(
  token: string,
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = resetPasswordSchema.safeParse({
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!parsed.success) {
    return {
      success: false,
      error: "Please check the highlighted fields.",
      fieldErrors: flattenFieldErrors(parsed.error),
    };
  }

  const result = await resetPasswordWithToken(token, parsed.data.password);

  if (result.outcome !== "reset") {
    // Expired/used/invalid tokens surface a user-actionable message; none
    // of them echo token material.
    return { success: false, error: result.message };
  }

  return { success: true, data: undefined };
}
