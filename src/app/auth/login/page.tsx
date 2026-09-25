import type { Metadata } from "next";
import Link from "next/link";

import {
  AuthFormShell,
  FormSuccess,
} from "@/components/auth/auth-form-shell";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = {
  title: "Log in",
};

export default async function LoginPage({
  searchParams,
}: PageProps<"/auth/login">) {
  const params = await searchParams;
  const justRegistered = params.registered === "1";
  const verifyEmailNotice = params.verify === "email";

  return (
    <AuthFormShell
      title="Welcome back"
      description="Log in to manage your campaigns and earnings."
      footer={
        <>
          New to Agenda?{" "}
          <Link
            href="/auth/register"
            className="font-medium text-accent hover:underline"
          >
            Create an account
          </Link>
        </>
      }
    >
      <div className="space-y-4">
        {justRegistered ? (
          <FormSuccess message="Account created. Log in to continue." />
        ) : null}
        {verifyEmailNotice ? (
          <div
            role="alert"
            className="rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-3 text-sm text-warning"
          >
            Verify your email address to connect a social account. Send a new
            link from your profile page after logging in, or use the resend
            form at{" "}
            <Link
              href="/auth/verify-email"
              className="font-medium underline underline-offset-4"
            >
              verify your email
            </Link>
            .
          </div>
        ) : null}
        <LoginForm />
      </div>
    </AuthFormShell>
  );
}
