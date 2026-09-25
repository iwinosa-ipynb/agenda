import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/dashboard/page-header";
import { CampaignStatusBadge } from "@/components/dashboard/status-badge";
import {
  CampaignLifecycleControls,
} from "@/components/dashboard/advertiser/campaign-lifecycle-controls";
import {
  AdvertiserCampaignPostsList,
} from "@/components/dashboard/advertiser/campaign-posts-list";
import { buttonClasses } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { CATEGORY_LABELS, PLATFORM_LABELS } from "@/lib/constants";
import { formatCount, formatDate, formatMoney } from "@/lib/utils";
import {
  getAdvertiserCampaign,
  getViewerAdvertiser,
  listAdvertiserApplications,
} from "@/services/advertiser.service";
import { getCampaignVerifiedViews } from "@/services/verified-views.service";
import type { AdvertiserApplicationSummary } from "@/types";

/**
 * The advertiser's management view of one of their own campaigns. Ownership is
 * resolved in the service — a foreign campaign id renders as not found.
 */
export async function AdvertiserCampaignDetailView({
  campaignId,
}: {
  campaignId: string;
}) {
  const { profile } = await getViewerAdvertiser();
  const campaign = await getAdvertiserCampaign(profile.id, campaignId);

  if (!campaign) {
    notFound();
  }

  const applications = await listAdvertiserApplications(profile.id, "ALL");
  const campaignApplications = applications.filter(
    (application) => application.campaign.id === campaign.id,
  );
  const pendingCount = campaignApplications.filter(
    (application) => application.status === "PENDING",
  ).length;

  // Server-computed from eligible verified posts only — never client-supplied.
  const verifiedViews = await getCampaignVerifiedViews(campaignId, {
    advertiserId: profile.id,
  });

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <Link
        href="/dashboard/campaigns"
        className="inline-flex items-center gap-1 text-sm text-ink-soft transition-colors hover:text-ink"
      >
        ← My campaigns
      </Link>

      <PageHeader
        title={campaign.title}
        action={<CampaignStatusBadge status={campaign.status} />}
        description={`Created for the ${PLATFORM_LABELS[campaign.platform]} audience.`}
      />

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr] lg:items-start">
        <div className="space-y-6">
          <Card className="p-6 sm:p-8">
            <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
              About this campaign
            </h2>
            <p className="mt-3 text-sm leading-relaxed whitespace-pre-line text-ink-soft">
              {campaign.description}
            </p>

            <h3 className="mt-8 text-sm font-semibold text-ink">
              Content requirements
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              {campaign.contentRequirements ??
                "No content requirements were specified."}
            </p>

            <h3 className="mt-6 text-sm font-semibold text-ink">
              Rules / instructions
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              {campaign.rules ?? "No additional rules were specified."}
            </p>
          </Card>

          <Card className="p-6 sm:p-8">
            <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
              Submitted content
            </h2>
            <p className="mt-1 text-sm text-ink-soft">
              Posts accepted creators have submitted for this campaign, with
              views confirmed by official platform verification.
            </p>
            <div className="mt-4">
              <AdvertiserCampaignPostsList campaignId={campaign.id} />
            </div>
          </Card>

          <Card className="p-6 sm:p-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
                  Applications
                </h2>
                <p className="mt-1 text-sm text-ink-soft">
                  {campaignApplications.length}{" "}
                  {campaignApplications.length === 1
                    ? "application"
                    : "applications"}
                  {pendingCount > 0 ? ` · ${pendingCount} pending` : ""}
                </p>
              </div>
              <Link
                href="/dashboard/applications"
                className={buttonClasses({ variant: "outline", size: "sm" })}
              >
                Review applications
              </Link>
            </div>

            {campaignApplications.length === 0 ? (
              <div className="mt-4">
                <EmptyState
                  title="No applications yet"
                  description="Applications from creators will appear here once your campaign is live."
                />
              </div>
            ) : (
              <ul className="mt-4 divide-y divide-line">
                {campaignApplications.map((application) => (
                  <ApplicationRow
                    key={application.id}
                    application={application}
                  />
                ))}
              </ul>
            )}
          </Card>
        </div>

        <aside className="space-y-6">
          <Card className="p-6">
            <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
              Campaign details
            </h2>
            <dl className="mt-4 divide-y divide-line">
              <Fact
                label="Platform"
                value={PLATFORM_LABELS[campaign.platform]}
              />
              <Fact
                label="Category"
                value={CATEGORY_LABELS[campaign.category]}
              />
              <Fact
                label="Target location"
                value={
                  campaign.targetCountry
                    ? `${campaign.targetLocation}, ${campaign.targetCountry}`
                    : campaign.targetLocation
                }
              />
              <Fact
                label="Minimum followers"
                value={`${formatCount(campaign.minimumFollowers)}+`}
              />
              <Fact
                label="Total verified views"
                value={
                  verifiedViews && verifiedViews.eligiblePostCount > 0
                    ? formatCount(verifiedViews.totalVerifiedViews)
                    : "0"
                }
              />
              {verifiedViews?.hasReviewFlag ? (
                <p className="border-t border-line py-3 text-xs leading-relaxed text-ink-soft">
                  One or more posts need additional verification before this
                  total is final.
                </p>
              ) : null}
              <Fact
                label="Budget"
                value={formatMoney(campaign.budget, campaign.currency)}
              />
              <Fact
                label="Creator slots"
                value={`${campaign.maxCreators} · quotes reviewed by you`}
              />
              <Fact
                label="Application deadline"
                value={
                  campaign.applicationDeadline
                    ? formatDate(campaign.applicationDeadline)
                    : "Open until filled"
                }
              />
              <Fact
                label="Campaign dates"
                value={
                  campaign.startDate && campaign.endDate
                    ? `${formatDate(campaign.startDate)} – ${formatDate(campaign.endDate)}`
                    : "Not set"
                }
              />
            </dl>

            <div className="mt-6">
              <CampaignLifecycleControls
                campaignId={campaign.id}
                status={campaign.status}
              />
            </div>
          </Card>

          <Card className="p-6">
            <div className="flex flex-wrap gap-1.5">
              <Badge tone="muted">{PLATFORM_LABELS[campaign.platform]}</Badge>
              <Badge tone="muted">{CATEGORY_LABELS[campaign.category]}</Badge>
              <Badge tone="muted">{campaign.targetLocation}</Badge>
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <dt className="text-sm text-ink-soft">{label}</dt>
      <dd className="text-right text-sm font-medium text-ink">{value}</dd>
    </div>
  );
}

function ApplicationRow({
  application,
}: {
  application: AdvertiserApplicationSummary;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-4 py-4">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-ink">
          {application.creator.name}
        </p>
        <p className="truncate text-xs text-ink-faint">
          @{application.creator.username} ·{" "}
          {formatCount(application.creator.followerCount)} followers
          (self-reported)
        </p>
      </div>
      <Link
        href={`/dashboard/applications/${application.id}`}
        className={buttonClasses({ variant: "outline", size: "sm" })}
      >
        Review
      </Link>
    </li>
  );
}
