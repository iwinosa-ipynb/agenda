import type { ReactNode } from "react";

import { requireRole } from "@/lib/authz";

/**
 * Every route inside this group is creator-only. Role is checked on the server
 * for each request, so an advertiser — or a Stage 14D SUPPORT operator — can
 * never reach creator functionality by typing a URL.
 */
export default async function CreatorLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireRole("CREATOR");

  return <>{children}</>;
}
