import "server-only";

import { redirect } from "next/navigation";

import { requireRole, requireUser } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/authz";

/**
 * Verified-email guard for sensitive actions (Stage 10).
 *
 * Login deliberately stays open for unverified accounts (product decision —
 * unverified users can browse and complete their profiles). Verification IS
 * required before sensitive marketplace actions; the first of these is the
 * creator social-account connection flow (Stage 8 routes), where a verified
 * identity chain matters.
 *
 * The check reads User.emailVerifiedAt server-side from the database — the
 * session/JWT is never trusted as proof of verification.
 */

export type VerifiedUser = {
  id: string;
  email: string;
  role: string;
};

export type VerificationGuardResult =
  | { allowed: true; user: VerifiedUser }
  | { allowed: false; reason: "unverified"; message: string };

export async function requireVerifiedUser(): Promise<VerificationGuardResult> {
  const sessionUser = await requireUser();

  const user = await prisma.user.findUnique({
    where: { id: sessionUser.id },
    select: { id: true, email: true, role: true, emailVerifiedAt: true },
  });

  if (!user) {
    // Session references a deleted account: treat as unauthenticated.
    throw new Error("Session user no longer exists.");
  }

  if (!user.emailVerifiedAt) {
    return {
      allowed: false,
      reason: "unverified",
      message:
        "Verify your email address before connecting a social account. You can request a new link from your profile page.",
    };
  }

  return {
    allowed: true,
    user: { id: user.id, email: user.email, role: user.role },
  };
}

/**
 * Creator + verified-email guard for the OAuth connect routes (Stage 11).
 *
 * Combines the role check (only creators connect social accounts) with the
 * Stage 10 email-verification gate — one call, no duplicated verification
 * logic. Unverified creators are redirected to the login page, which links
 * the resend-verification flow.
 */
export async function requireVerifiedCreator(): Promise<SessionUser> {
  const guard = await requireVerifiedUser();

  if (!guard.allowed) {
    redirect("/auth/login?verify=email");
  }

  return requireRole("CREATOR");
}
