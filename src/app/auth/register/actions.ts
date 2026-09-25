"use server";

import { redirect } from "next/navigation";

import { issueVerificationForNewUser } from "@/services/email-verification.service";
import { createUser } from "@/services/user.service";
import type { ActionResult } from "@/types";
import { registerSchema } from "@/validation/auth";
import { flattenFieldErrors } from "@/validation/errors";

export async function registerAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = registerSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    role: formData.get("role"),
  });

  if (!parsed.success) {
    return {
      success: false,
      error: "Please check the highlighted fields.",
      fieldErrors: flattenFieldErrors(parsed.error),
    };
  }

  const result = await createUser(parsed.data);

  if (!result.success) {
    return result;
  }

  // Stage 10: the account starts email-unverified. Create the first
  // verification challenge and send the email. Provider problems never
  // block signup — the user can request a new link later, and the email
  // configuration failure is surfaced explicitly (no fake delivery).
  await issueVerificationForNewUser({
    userId: result.data.userId,
    email: parsed.data.email,
  });

  redirect("/auth/login?registered=1");
}
