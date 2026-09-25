import type { Metadata } from "next";
import type { ReactNode } from "react";

import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { requireUser } from "@/lib/authz";

export const metadata: Metadata = {
  title: "Dashboard",
};

// Authorization is resolved on the server for every dashboard request.
export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await requireUser();

  return <DashboardShell user={user}>{children}</DashboardShell>;
}
