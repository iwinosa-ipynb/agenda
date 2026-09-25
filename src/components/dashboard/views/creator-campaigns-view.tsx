import Link from "next/link";

import { CampaignCard } from "@/components/dashboard/creator/campaign-card";
import { CampaignFilters } from "@/components/dashboard/creator/campaign-filters";
import { PageHeader } from "@/components/dashboard/page-header";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { requireRole } from "@/lib/authz";
import { listCampaigns } from "@/services/campaign.service";
import { parseCampaignFilters } from "@/validation/campaign";

export async function CreatorCampaignsView({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole("CREATOR");

  const params = await searchParams;
  const filters = parseCampaignFilters(params);
  const campaigns = await listCampaigns(filters);
  const hasFilters = Object.keys(filters).length > 0;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <PageHeader
        title="Campaigns"
        description="Campaigns that are open for applications right now."
      />

      <CampaignFilters filters={filters} />

      <p className="text-sm text-ink-soft">
        {campaigns.length} {campaigns.length === 1 ? "campaign" : "campaigns"}
      </p>

      {campaigns.length === 0 ? (
        <EmptyState
          title={
            hasFilters
              ? "No campaigns match those filters"
              : "No campaigns are open yet"
          }
          description={
            hasFilters
              ? "Try widening your search or clearing a filter."
              : "When brands launch campaigns on Agenda they'll show up here."
          }
          action={
            hasFilters ? (
              <Link
                href="/dashboard/campaigns"
                className={buttonClasses({ variant: "outline", size: "sm" })}
              >
                Clear filters
              </Link>
            ) : undefined
          }
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {campaigns.map((campaign) => (
            <li key={campaign.id} className="h-full">
              <CampaignCard campaign={campaign} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
