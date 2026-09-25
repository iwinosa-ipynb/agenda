import type { Metadata } from "next";
import Link from "next/link";

import { AuthFormShell } from "@/components/auth/auth-form-shell";
import { RegisterForm } from "@/components/auth/register-form";
import type { UserRole } from "@/types";

export const metadata: Metadata = {
  title: "Create an account",
};

function resolveDefaultRole(value: string | string[] | undefined): UserRole {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate?.toUpperCase() === "ADVERTISER" ? "ADVERTISER" : "CREATOR";
}

export default async function RegisterPage({
  searchParams,
}: PageProps<"/auth/register">) {
  const params = await searchParams;

  return (
    <AuthFormShell
      title="Create your account"
      description="Pick the side of the marketplace you're joining — you can always add the other later."
      footer={
        <>
          Already have an account?{" "}
          <Link
            href="/auth/login"
            className="font-medium text-accent hover:underline"
          >
            Log in
          </Link>
        </>
      }
    >
      <RegisterForm defaultRole={resolveDefaultRole(params.role)} />
    </AuthFormShell>
  );
}
