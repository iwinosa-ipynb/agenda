import Link from "next/link";

import { PageHeader } from "@/components/dashboard/page-header";
import { CampaignStatusBadge } from "@/components/dashboard/status-badge";
import { buttonClasses } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { CATEGORY_LABELS, PLATFORM_LABELS } from "@/lib/constants";
import { formatDate, formatMoney } from "@/lib/utils";
import {
  getViewerAdvertiser,
  listAdvertiserCampaigns,
} from "@/services/advertiser.service";
import type { AdvertiserCampaignSummary } from "@/types";

export async function AdvertiserCampaignsView() {
  const { profile } = await getViewerAdvertiser();
  const campaigns = await listAdvertiserCampaigns(profile.id);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <PageHeader
        title="My campaigns"
        description="Everything you've created on Agenda — drafts, live campaigns and history."
        action={
          <Link
            href="/dashboard/campaigns/new"
            className={buttonClasses({ variant: "accent", size: "sm" })}
          >
            Create campaign
          </Link>
        }
      />

      {campaigns.length === 0 ? (
        <EmptyState
          title="No campaigns yet"
          description="Create your first campaign to start reaching Agenda's creators. You can save it as a draft and publish it when it's ready."
          action={
            <Link
              href="/dashboard/campaigns/new"
              className={buttonClasses({ variant: "accent", size: "sm" })}
            >
              Create campaign
            </Link>
          }
        />
      ) : (
        <ul className="space-y-4">
          {campaigns.map((campaign) => (
            <li key={campaign.id}>
              <CampaignRow campaign={campaign} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CampaignRow({ campaign }: { campaign: AdvertiserCampaignSummary }) {
  return (
    <Link href={`/dashboard/campaigns/${campaign.id}`} className="group block">
      <Card className="p-5 transition-colors group-hover:border-line-strong">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1.5">
            <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
              {campaign.title}
            </h2>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone="muted">{PLATFORM_LABELS[campaign.platform]}</Badge>
              <Badge tone="muted">{CATEGORY_LABELS[campaign.category]}</Badge>
              <Badge tone="muted">
                {campaign.targetCountry
                  ? `${campaign.targetLocation}, ${campaign.targetCountry}`
                  : campaign.targetLocation}
              </Badge>
            </div>
          </div>

          <CampaignStatusBadge status={campaign.status} />
        </div>

        <dl className="mt-5 grid gap-4 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs text-ink-faint">Budget</dt>
            <dd className="mt-0.5 text-sm font-semibold text-ink">
              {formatMoney(campaign.budget, campaign.currency)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-faint">Creator slots</dt>
            <dd className="mt-0.5 text-sm font-semibold text-ink">
              {campaign.maxCreators}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-faint">Application deadline</dt>
            <dd className="mt-0.5 text-sm text-ink">
              {campaign.applicationDeadline
                ? formatDate(campaign.applicationDeadline)
                : "Open until filled"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-faint">Applications</dt>
            <dd className="mt-0.5 text-sm text-ink">
              {campaign.applicationCount}
            </dd>
          </div>
        </dl>
      </Card>
    </Link>
  );
}
