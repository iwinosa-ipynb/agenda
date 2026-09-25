import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CampaignForm } from "@/components/dashboard/advertiser/campaign-form";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/card";
import { requireRole } from "@/lib/authz";
import { CAMPAIGN_STATUS_LABELS } from "@/lib/constants";
import {
  getAdvertiserCampaign,
  getViewerAdvertiser,
} from "@/services/advertiser.service";

type EditParams = PageProps<"/dashboard/campaigns/[id]/edit">;

export const metadata: Metadata = {
  title: "Edit campaign",
};

/**
 * Advertiser-only edit page. The service scopes the lookup to the signed-in
 * advertiser, so another advertiser's campaign id renders as not found.
 */
export default async function EditCampaignPage({ params }: EditParams) {
  await requireRole("ADVERTISER");

  const { id } = await params;
  const { profile } = await getViewerAdvertiser();
  const campaign = await getAdvertiserCampaign(profile.id, id);

  if (!campaign) {
    notFound();
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <Link
        href={`/dashboard/campaigns/${campaign.id}`}
        className="inline-flex items-center gap-1 text-sm text-ink-soft transition-colors hover:text-ink"
      >
        ← Back to campaign
      </Link>

      <PageHeader
        eyebrow="Editing"
        title={campaign.title}
        description="Changes are visible to creators as soon as you save."
        action={
          <Badge tone="muted">{CAMPAIGN_STATUS_LABELS[campaign.status]}</Badge>
        }
      />

      <Card className="p-6 sm:p-8">
        <CampaignForm campaign={campaign} />
      </Card>
    </div>
  );
}
