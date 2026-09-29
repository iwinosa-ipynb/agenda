import type { Metadata } from "next";
import Link from "next/link";

import { AuthFormShell } from "@/components/auth/auth-form-shell";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

export const metadata: Metadata = {
  title: "Forgot password",
};

/**
 * Forgot-password page.
 *
 * The form's confirmation is enumeration-safe: the same generic message is
 * shown whether or not the address belongs to an Agenda account, so this
 * page never reveals which emails are registered.
 */
export default function ForgotPasswordPage() {
  return (
    <AuthFormShell
      title="Forgot your password?"
      description="Enter the email address on your account and we'll send you a reset link."
      footer={
        <>
          Remembered it?{" "}
          <Link
            href="/auth/login"
            className="font-medium text-accent hover:underline"
          >
            Log in
          </Link>
        </>
      }
    >
      <ForgotPasswordForm />
    </AuthFormShell>
  );
}
