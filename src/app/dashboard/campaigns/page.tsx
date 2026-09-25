import type { Metadata } from "next";

import { CreatorCampaignsView } from "@/components/dashboard/views/creator-campaigns-view";
import { AdvertiserCampaignsView } from "@/components/dashboard/views/advertiser-campaigns-view";
import { requireUser } from "@/lib/authz";

export const metadata: Metadata = {
  title: "Campaigns",
};

/**
 * Shared route: creators see the marketplace, advertisers see their own
 * campaigns. The role is resolved server-side on every request.
 */
export default async function CampaignsPage({
  searchParams,
}: PageProps<"/dashboard/campaigns">) {
  const user = await requireUser();

  if (user.role === "ADVERTISER") {
    return <AdvertiserCampaignsView />;
  }

  return <CreatorCampaignsView searchParams={searchParams} />;
}
