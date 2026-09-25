import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * Verification-status read for the authenticated dashboard (Stage 10).
 * Returns only display-safe fields: the email and the verification
 * timestamp. Never returns token or challenge material.
 */
export async function getAccountEmailVerificationStatus(userId: string): Promise<{
  email: string;
  emailVerifiedAt: Date | null;
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerifiedAt: true },
  });

  // requireUser() guarantees the session user exists; this is a defensive
  // fallback so a data anomaly cannot crash the dashboard.
  return {
    email: user?.email ?? "",
    emailVerifiedAt: user?.emailVerifiedAt ?? null,
  };
}
