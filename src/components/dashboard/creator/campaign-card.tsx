import Link from "next/link";

import { CampaignStatusBadge } from "@/components/dashboard/status-badge";
import { Badge, Card } from "@/components/ui/card";
import { CATEGORY_LABELS, PLATFORM_LABELS } from "@/lib/constants";
import {
  formatCount,
  formatDeadline,
  formatMoney,
} from "@/lib/utils";
import type { CampaignSummary } from "@/types";

export function CampaignCard({ campaign }: { campaign: CampaignSummary }) {
  return (
    <Link
      href={`/dashboard/campaigns/${campaign.id}`}
      className="group block h-full rounded-xl transition-[color,background-color,border-color,scale] duration-150 ease-out pressed:scale-[0.99] motion-reduce:pressed:scale-100"
    >
      <Card className="flex h-full flex-col p-5 transition-colors group-hover:border-line-strong">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-xs text-ink-faint">
              {campaign.advertiser.companyName}
            </p>
            <h3 className="mt-1 text-base font-semibold tracking-[-0.01em] text-ink">
              {campaign.title}
            </h3>
          </div>
          <CampaignStatusBadge status={campaign.status} />
        </div>

        <div className="mt-4 flex flex-wrap gap-1.5">
          <Badge tone="muted">{PLATFORM_LABELS[campaign.platform]}</Badge>
          <Badge tone="muted">{CATEGORY_LABELS[campaign.category]}</Badge>
          <Badge tone="muted">{campaign.targetLocation}</Badge>
          <Badge tone="muted">
            {formatCount(campaign.minimumFollowers)}+ followers
          </Badge>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-line pt-4">
          <div>
            <dt className="text-xs text-ink-faint">Budget</dt>
            <dd className="mt-0.5 text-sm font-semibold text-ink">
              {formatMoney(campaign.budget, campaign.currency)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-faint">Your fee</dt>
            <dd className="mt-0.5 text-sm font-semibold text-ink">
              You set it
              <span className="ml-1 text-xs font-normal text-ink-faint">
                — quote what it&apos;s worth
              </span>
            </dd>
          </div>
        </dl>

        <p className="mt-auto pt-4 text-xs text-ink-faint">
          {formatDeadline(campaign.applicationDeadline)}
        </p>
      </Card>
    </Link>
  );
}
