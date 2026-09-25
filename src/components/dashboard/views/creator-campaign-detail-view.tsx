import Link from "next/link";
import { notFound } from "next/navigation";

import { ApplyToCampaign } from "@/components/dashboard/creator/apply-to-campaign";
import { PageHeader } from "@/components/dashboard/page-header";
import {
  ApplicationStatusBadge,
  CampaignStatusBadge,
} from "@/components/dashboard/status-badge";
import { buttonClasses } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { CATEGORY_LABELS, PLATFORM_LABELS } from "@/lib/constants";
import {
  formatCount,
  formatDate,
  formatDeadline,
  formatMoney,
  isDeadlinePassed,
} from "@/lib/utils";
import {
  getCreatorApplicationForCampaign,
  getQuoteGuidance,
} from "@/services/application.service";
import { getCampaignDetail } from "@/services/campaign.service";
import { getViewerCreator } from "@/services/creator.service";
import { listActiveRateCardItems } from "@/services/rate-card.service";

function RequirementRow({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex items-start justify-between gap-4 border-b border-line pb-3 last:border-b-0 last:pb-0">
      <span className="text-sm text-ink-soft">{label}</span>
      <span className="text-right text-sm font-medium text-ink">{value}</span>
    </li>
  );
}

export async function CreatorCampaignDetailView({
  params,
}: {
  params: PageProps<"/dashboard/campaigns/[id]">["params"];
}) {
  const { profile } = await getViewerCreator();
  const { id } = await params;

  const campaign = await getCampaignDetail(id);

  // Drafts are advertiser-only work-in-progress. A creator who guesses a URL
  // must see a 404, not someone's unpublished campaign.
  if (!campaign || campaign.status === "DRAFT") {
    notFound();
  }

  const [application, guidance, myRates] = await Promise.all([
    getCreatorApplicationForCampaign(profile.id, campaign.id),
    // Pricing guidance: data-backed range or an explicit "insufficient data"
    // message. Never fabricated numbers (Stage 12).
    getQuoteGuidance(campaign.id),
    // The creator's own listed rate for this platform, as reference only.
    // It never pre-fills the quote — every quote is typed fresh per campaign.
    listActiveRateCardItems(profile.id),
  ]);

  const listedRate = myRates.find(
    (item) => item.platform === campaign.platform,
  );

  const closed =
    campaign.status !== "PUBLISHED" ||
    isDeadlinePassed(campaign.applicationDeadline);

  const facts = [
    { label: "Platform", value: PLATFORM_LABELS[campaign.platform] },
    { label: "Category", value: CATEGORY_LABELS[campaign.category] },
    { label: "Target location", value: campaign.targetLocation },
    {
      label: "Minimum followers",
      value: `${formatCount(campaign.minimumFollowers)}+`,
    },
    { label: "Budget", value: formatMoney(campaign.budget, campaign.currency) },
    {
      label: "Creators wanted",
      value: String(campaign.maxCreators),
    },
    {
      label: "Application deadline",
      value: campaign.applicationDeadline
        ? formatDate(campaign.applicationDeadline)
        : "Open until filled",
    },
    {
      label: "Campaign dates",
      value:
        campaign.startDate && campaign.endDate
          ? `${formatDate(campaign.startDate)} – ${formatDate(campaign.endDate)}`
          : "To be confirmed",
    },
    { label: "Applications", value: String(campaign.applicationCount) },
  ];

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <Link
        href="/dashboard/campaigns"
        className="inline-flex items-center gap-1 text-sm text-ink-soft transition-colors hover:text-ink"
      >
        ← All campaigns
      </Link>

      <PageHeader
        eyebrow={campaign.advertiser.companyName}
        title={campaign.title}
        description={formatDeadline(campaign.applicationDeadline)}
        action={<CampaignStatusBadge status={campaign.status} />}
      />

      {campaign.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {campaign.tags.map((tag) => (
            <Badge key={tag} tone="muted">
              {tag}
            </Badge>
          ))}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr] lg:items-start">
        <div className="space-y-6">
          <Card className="p-6 sm:p-8">
            <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
              About this campaign
            </h2>
            <p className="mt-3 text-sm leading-relaxed whitespace-pre-line text-ink-soft">
              {campaign.description}
            </p>

            {campaign.advertiser.companyDescription ? (
              <>
                <h3 className="mt-6 text-sm font-semibold text-ink">
                  About {campaign.advertiser.companyName}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                  {campaign.advertiser.companyDescription}
                </p>
              </>
            ) : null}

            {campaign.advertiser.website ? (
              <a
                href={campaign.advertiser.website}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-3 inline-block text-sm text-accent underline-offset-4 hover:underline"
              >
                {campaign.advertiser.website}
              </a>
            ) : null}
          </Card>

          <Card className="p-6 sm:p-8">
            <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
              Requirements
            </h2>

            <ul className="mt-4 space-y-3">
              <RequirementRow
                label="Minimum followers"
                value={`${formatCount(campaign.minimumFollowers)}+`}
              />
              <RequirementRow
                label="Platform"
                value={PLATFORM_LABELS[campaign.platform]}
              />
              <RequirementRow
                label="Category"
                value={CATEGORY_LABELS[campaign.category]}
              />
              <RequirementRow
                label="Target location"
                value={campaign.targetLocation}
              />
            </ul>

            <h3 className="mt-8 text-sm font-semibold text-ink">
              Content requirements
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              {campaign.contentRequirements ??
                "The advertiser hasn't added extra content requirements yet."}
            </p>

            <h3 className="mt-6 text-sm font-semibold text-ink">
              Important rules
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              {campaign.rules ??
                "No additional rules were specified for this campaign."}
            </p>
          </Card>
        </div>

        <aside className="space-y-6">
          <Card className="p-6">
            <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
              Key facts
            </h2>
            <dl className="mt-4 divide-y divide-line">
              {facts.map((fact) => (
                <div
                  key={fact.label}
                  className="flex items-start justify-between gap-4 py-3"
                >
                  <dt className="text-sm text-ink-soft">{fact.label}</dt>
                  <dd className="text-right text-sm font-medium text-ink">
                    {fact.value}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card className="p-6">
            <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
              {application ? "Your application" : "Apply"}
            </h2>

            {application ? (
              <div className="mt-4 space-y-3">
                <ApplicationStatusBadge status={application.status} />
                <p className="text-sm leading-relaxed text-ink-soft">
                  You&apos;ve already applied to this campaign. You can track it
                  under My applications.
                </p>
                <Link
                  href="/dashboard/applications"
                  className={buttonClasses({ variant: "outline", size: "sm" })}
                >
                  View my applications
                </Link>
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                <p className="text-sm leading-relaxed text-ink-soft">
                  Tell the advertiser your fee for this campaign. If they
                  accept, that quote becomes your guaranteed pay for the
                  deliverables below.
                </p>
                {listedRate ? (
                  <p className="rounded-lg border border-line bg-surface-muted px-3.5 py-3 text-xs leading-relaxed text-ink-soft">
                    <span className="font-medium text-ink">
                      Your listed rate for {PLATFORM_LABELS[campaign.platform]}:
                      {" "}
                      {formatMoney(listedRate.price, listedRate.currency)}
                    </span>{" "}
                    — a starting reference only. Quote what this campaign is
                    worth to you.
                  </p>
                ) : null}
                <ApplyToCampaign
                  campaignId={campaign.id}
                  currency={campaign.currency}
                  closed={closed}
                  guidance={{
                    dataAvailability: guidance.dataAvailability,
                    explanation: guidance.explanation,
                    suggestedMin: guidance.suggestedMin,
                    suggestedMax: guidance.suggestedMax,
                  }}
                />
              </div>
            )}
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
