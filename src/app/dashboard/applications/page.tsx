import type { Metadata } from "next";

import { CreatorApplicationsView } from "@/components/dashboard/views/creator-applications-view";
import { AdvertiserApplicationsView } from "@/components/dashboard/views/advertiser-applications-view";
import { requireUser } from "@/lib/authz";

export const metadata: Metadata = {
  title: "Applications",
};

/**
 * Shared route: creators see applications they sent, advertisers see
 * applications received by their campaigns. Role resolved server-side.
 */
export default async function ApplicationsPage() {
  const user = await requireUser();

  if (user.role === "ADVERTISER") {
    return <AdvertiserApplicationsView />;
  }

  return <CreatorApplicationsView />;
}
