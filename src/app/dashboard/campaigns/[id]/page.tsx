import type { Metadata } from "next";

import { CreatorCampaignDetailView } from "@/components/dashboard/views/creator-campaign-detail-view";
import { AdvertiserCampaignDetailView } from "@/components/dashboard/views/advertiser-campaign-detail-view";
import { requireUser } from "@/lib/authz";

export const metadata: Metadata = {
  title: "Campaign",
};

/**
 * Shared route: creators see the public campaign view, the owning advertiser
 * sees their management view. Advertisers who do not own the campaign get the
 * creator-style read-only view rather than an error, but can never manage it.
 */
export default async function CampaignDetailPage({
  params,
}: PageProps<"/dashboard/campaigns/[id]">) {
  const user = await requireUser();
  const { id } = await params;

  if (user.role === "ADVERTISER") {
    return <AdvertiserCampaignDetailView campaignId={id} />;
  }

  return <CreatorCampaignDetailView params={Promise.resolve({ id })} />;
}
