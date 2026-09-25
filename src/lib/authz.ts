import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import type { UserRole } from "@/types";

export type SessionUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  role: UserRole;
};

/**
 * Server-side guard for authenticated routes. Always resolve authorization on
 * the server — never trust a role supplied by the client.
 */
export async function requireUser(redirectTo = "/auth/login"): Promise<SessionUser> {
  const session = await auth();

  if (!session?.user?.id) {
    redirect(redirectTo);
  }

  return session.user;
}

/** Guard for routes that are only valid for a single role. */
export async function requireRole(role: UserRole): Promise<SessionUser> {
  const user = await requireUser();

  if (user.role !== role) {
    redirect("/dashboard");
  }

  return user;
}
