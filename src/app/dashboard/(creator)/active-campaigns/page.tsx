import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/dashboard/page-header";
import {
  CampaignStatusBadge,
  PostStatusBadge,
} from "@/components/dashboard/status-badge";
import { buttonClasses } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PLATFORM_LABELS } from "@/lib/constants";
import {
  formatVerifiedMetric,
  getLastVerifiedLabel,
} from "@/lib/verified-view-display";
import { formatDate, formatMoney } from "@/lib/utils";
import { listActiveCampaigns } from "@/services/application.service";
import { requireViewerCreatorId } from "@/services/creator.service";
import {
  listCreatorCampaignPosts,
} from "@/services/post.service";

export const metadata: Metadata = {
  title: "Active campaigns",
};

function campaignDates(start: Date | null, end: Date | null): string {
  if (start && end) {
    return `${formatDate(start)} – ${formatDate(end)}`;
  }
  if (start) {
    return `Starts ${formatDate(start)}`;
  }
  return "Dates to be confirmed";
}

export default async function ActiveCampaignsPage() {
  const creatorId = await requireViewerCreatorId();
  const [activeCampaigns, posts] = await Promise.all([
    listActiveCampaigns(creatorId),
    listCreatorCampaignPosts(creatorId),
  ]);

  // Index the creator's submissions by campaign so each accepted campaign can
  // show the current submission state without extra queries.
  const postsByCampaign = new Map<string, typeof posts>();
  for (const post of posts) {
    const list = postsByCampaign.get(post.campaign.id) ?? [];
    list.push(post);
    postsByCampaign.set(post.campaign.id, list);
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <PageHeader
        title="Active campaigns"
        description="Campaigns you've been accepted into."
      />

      {activeCampaigns.length === 0 ? (
        <EmptyState
          title="No active campaigns"
          description="When an advertiser accepts one of your applications, the campaign will appear here."
          action={
            <Link
              href="/dashboard/applications"
              className={buttonClasses({ variant: "outline", size: "sm" })}
            >
              View my applications
            </Link>
          }
        />
      ) : (
        <ul className="space-y-4">
          {activeCampaigns.map((item) => (
            <li key={item.applicationId}>
              <Card className="p-5 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 space-y-1.5">
                    <p className="text-xs text-ink-faint">
                      {item.advertiser.companyName}
                    </p>
                    <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
                      {item.campaign.title}
                    </h2>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge tone="muted">
                        {PLATFORM_LABELS[item.campaign.platform]}
                      </Badge>
                      <CampaignStatusBadge status={item.campaign.status} />
                    </div>
                  </div>

                  <Link
                    href={`/dashboard/campaigns/${item.campaign.id}`}
                    className={buttonClasses({ variant: "outline", size: "sm" })}
                  >
                    View campaign
                  </Link>
                </div>

                <dl className="mt-5 grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-ink-faint">Your agreed fee</dt>
                    <dd className="mt-0.5 text-sm font-semibold text-ink">
                      {formatMoney(item.agreedQuote, item.currency)}
                      <span className="ml-1 text-xs font-normal text-ink-faint">
                        guaranteed
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink-faint">Campaign dates</dt>
                    <dd className="mt-0.5 text-sm text-ink">
                      {campaignDates(
                        item.campaign.startDate,
                        item.campaign.endDate,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink-faint">
                      Content requirements
                    </dt>
                    <dd className="mt-0.5 text-sm text-ink-soft">
                      {item.campaign.contentRequirements ??
                        "Not specified yet."}
                    </dd>
                  </div>
                </dl>

                {(() => {
                  const campaignPosts = postsByCampaign.get(item.campaign.id) ?? [];
                  const activePost = campaignPosts.find(
                    (post) => post.status !== "REJECTED",
                  );

                  if (activePost) {
                    return (
                      <div className="mt-5 rounded-lg border border-dashed border-line-strong bg-surface-muted p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm font-medium text-ink">
                            Content submitted
                          </p>
                          <PostStatusBadge status={activePost.status} />
                        </div>
                        <p className="mt-1 truncate text-xs text-ink-soft">
                          {activePost.postUrl}
                        </p>

                        <dl className="mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-3">
                          <div>
                            <dt className="text-xs text-ink-faint">
                              Verified views
                            </dt>
                            <dd className="mt-0.5 text-sm font-semibold text-ink">
                              {formatVerifiedMetric(
                                activePost.status,
                                activePost.verifiedViews,
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-xs text-ink-faint">
                              Last verified
                            </dt>
                            <dd className="mt-0.5 text-sm text-ink">
                              {getLastVerifiedLabel(
                                activePost.lastSyncedAt,
                                activePost.status,
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-xs text-ink-faint">
                              Verification status
                            </dt>
                            <dd className="mt-0.5 text-sm text-ink">
                              {activePost.status === "VERIFYING"
                                ? "Running now"
                                : activePost.status === "SUBMITTED"
                                  ? "Awaiting verification"
                                  : "—"}
                            </dd>
                          </div>
                        </dl>
                      </div>
                    );
                  }

                  const rejectedPost = campaignPosts.find(
                    (post) => post.status === "REJECTED",
                  );

                  return (
                    <div className="mt-5 rounded-lg border border-dashed border-line-strong bg-surface-muted p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium text-ink">
                          {rejectedPost ? "Resubmit content" : "Submit content"}
                        </p>
                        {rejectedPost ? (
                          <PostStatusBadge status={rejectedPost.status} />
                        ) : null}
                      </div>
                      <p className="mt-1 text-xs leading-relaxed text-ink-soft">
                        {rejectedPost
                          ? "Your previous submission was rejected. Submit a replacement post when it's ready."
                          : "Add the link to the post you published for this campaign."}
                      </p>
                      <Link
                        href={`/dashboard/active-campaigns/${item.campaign.id}/submit`}
                        className={buttonClasses({
                          variant: "outline",
                          size: "sm",
                          className: "mt-3",
                        })}
                      >
                        {rejectedPost ? "Resubmit content" : "Submit content"}
                      </Link>
                    </div>
                  );
                })()}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
