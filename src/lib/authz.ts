import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
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

/**
 * Non-redirecting variant of requireUser for authorization checks that must
 * return a verdict instead of navigating (server actions, tests).
 * Anonymous callers resolve to null — fail-closed by construction.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();

  if (!session?.user?.id) {
    return null;
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

// ---------------------------------------------------------------------------
// Stage 14D — Support (trusted internal operator) authorization
// ---------------------------------------------------------------------------

/**
 * Resolve the caller's Support authorization status from server-side facts
 * ONLY: the session (identity + role claim) and the operator-maintained
 * support roster (User.supportRosterMember — never client-writable).
 *
 * STAGE 14D AUTHORIZATION MATRIX (fail-closed on every row):
 *   unauthenticated                          → null (rejected)
 *   role CREATOR (even roster=true*)         → null (rejected)
 *   role ADVERTISER (even roster=true*)      → null (rejected)
 *   role SUPPORT  + roster=false             → null (rejected)
 *   role SUPPORT  + roster=true              → session user (authorized)
 *   no session-user id on the JWT            → null (rejected)
 *
 *   (*today no non-SUPPORT account can hold roster membership; the role
 *   check makes the invariant structural rather than assumed.)
 *
 * The roster is re-read FRESH from the database on every call — the JWT role
 * claim alone is never sufficient, so a roster revocation takes effect on
 * the very next request even while an old JWT still says SUPPORT.
 *
 * Never trust a role or support status from a client form field; the only
 * inputs here are the server session and the server database.
 */
export async function getSupportActor(): Promise<SessionUser | null> {
  // Non-redirecting base: services/actions need a VERDICT (null), never a
  // navigation — only requireSupport() decides to redirect.
  const user = await getSessionUser();

  if (user?.role !== "SUPPORT" || !user.id) {
    return null;
  }

  // Fresh-DB roster check (revocation kill switch — see doc above).
  const roster = await prisma.user.findUnique({
    where: { id: user.id },
    select: { supportRosterMember: true },
  });

  if (roster?.supportRosterMember !== true) {
    return null;
  }

  return user;
}

/**
 * Guard for Support-only routes. Authorized support actors pass through;
 * everyone else is redirected: anonymous callers to the login page (the
 * app-wide convention) and authenticated non-support or revoked/roster-less
 * SUPPORT sessions to the dashboard overview.
 */
export async function requireSupport(): Promise<SessionUser> {
  const session = await getSessionUser();

  if (!session) {
    redirect("/auth/login");
  }

  const actor = await getSupportActor();

  if (!actor) {
    redirect("/dashboard");
  }

  return actor;
}
