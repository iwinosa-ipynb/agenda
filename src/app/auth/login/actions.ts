"use server";

import { AuthError } from "next-auth";

import { signIn } from "@/lib/auth";
import type { ActionResult } from "@/types";
import { loginSchema } from "@/validation/auth";
import { flattenFieldErrors } from "@/validation/errors";

export async function loginAction(
  _prevState: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return {
      success: false,
      error: "Please check the highlighted fields.",
      fieldErrors: flattenFieldErrors(parsed.error),
    };
  }

  try {
    await signIn("credentials", {
      email: parsed.data.email,
      password: parsed.data.password,
      redirectTo: "/dashboard",
    });

    return { success: true, data: undefined };
  } catch (error) {
    if (error instanceof AuthError) {
      return { success: false, error: "Invalid email or password." };
    }

    // Redirects and unexpected failures must bubble up.
    throw error;
  }
}
