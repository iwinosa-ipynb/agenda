import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { SubmitPostForm } from "@/components/dashboard/creator/submit-post-form";
import { PageHeader } from "@/components/dashboard/page-header";
import { Badge, Card } from "@/components/ui/card";
import { PLATFORM_LABELS } from "@/lib/constants";
import { formatDate } from "@/lib/utils";
import { requireViewerCreatorId } from "@/services/creator.service";
import { getCreatorCampaignSubmissionContext } from "@/services/post.service";

export const metadata: Metadata = {
  title: "Submit content",
};

/**
 * Creator-only submission page. Access is justified server-side by an ACCEPTED
 * application: session → creator → accepted application → campaign. Anything
 * else renders as not found so submission data never leaks to outsiders.
 */
export default async function SubmitContentPage({
  params,
}: PageProps<"/dashboard/active-campaigns/[campaignId]/submit">) {
  const creatorId = await requireViewerCreatorId();
  const { campaignId } = await params;

  const context = await getCreatorCampaignSubmissionContext(
    creatorId,
    campaignId,
  );

  if (!context) {
    notFound();
  }

  const { campaign, advertiser, posts } = context;
  const hasActiveSubmission = posts.some((post) => post.status !== "REJECTED");
  const latestPost = posts[0];

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <Link
        href="/dashboard/active-campaigns"
        className="inline-flex items-center gap-1 text-sm text-ink-soft transition-colors hover:text-ink"
      >
        ← Active campaigns
      </Link>

      <PageHeader
        eyebrow={advertiser.companyName}
        title={campaign.title}
        description="Submit the content you published for this campaign."
        action={<Badge tone="muted">{PLATFORM_LABELS[campaign.platform]}</Badge>}
      />

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr] lg:items-start">
        <Card className="p-6 sm:p-8">
          {hasActiveSubmission && latestPost ? (
            <div className="space-y-4">
              <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
                Already submitted
              </h2>
              <p className="text-sm leading-relaxed text-ink-soft">
                {latestPost.status === "REJECTED"
                  ? "Your previous submission was rejected. You can submit a replacement post below."
                  : "You've already submitted content for this campaign."}
              </p>
              <div className="rounded-lg border border-line bg-surface-muted px-3.5 py-3">
                <p className="truncate text-sm font-medium text-ink">
                  {latestPost.postUrl}
                </p>
                <p className="mt-1 text-xs text-ink-faint">
                  Submitted {formatDate(latestPost.createdAt)}
                </p>
              </div>
              {latestPost.status === "REJECTED" ? (
                <div className="pt-2">
                  <h3 className="text-sm font-semibold text-ink">
                    Submit a replacement
                  </h3>
                  <div className="mt-4">
                    <SubmitPostForm campaignId={campaign.id} />
                  </div>
                </div>
              ) : (
                <p className="text-sm text-ink-soft">
                  Track its status under{" "}
                  <Link
                    href="/dashboard/posts"
                    className="font-medium text-accent underline-offset-4 hover:underline"
                  >
                    My posts
                  </Link>
                  .
                </p>
              )}
            </div>
          ) : (
            <>
              <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
                Submit your content
              </h2>
              <p className="mt-1 text-sm text-ink-soft">
                Paste the link to the post you published for this campaign.
              </p>
              <div className="mt-6">
                <SubmitPostForm campaignId={campaign.id} />
              </div>
            </>
          )}
        </Card>

        <aside className="space-y-6">
          <Card className="p-6">
            <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
              Campaign requirements
            </h2>
            <dl className="mt-4 divide-y divide-line">
              <Fact
                label="Platform"
                value={PLATFORM_LABELS[campaign.platform]}
              />
              <Fact
                label="Campaign dates"
                value={
                  campaign.startDate && campaign.endDate
                    ? `${formatDate(campaign.startDate)} – ${formatDate(campaign.endDate)}`
                    : "To be confirmed"
                }
              />
            </dl>

            <h3 className="mt-6 text-sm font-semibold text-ink">
              Content requirements
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              {campaign.contentRequirements ??
                "The advertiser hasn't added extra content requirements."}
            </p>

            <h3 className="mt-6 text-sm font-semibold text-ink">Rules</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              {campaign.rules ?? "No additional rules were specified."}
            </p>
          </Card>

          <Card className="p-6">
            <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
              How verification works
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-ink-soft">
              Your post will be submitted for verification. Views and engagement
              are not manually entered and will only count toward payment after
              Agenda verifies them.
            </p>
            <p className="mt-3 rounded-lg border border-dashed border-line-strong bg-surface-muted px-3.5 py-3 text-xs leading-relaxed text-ink-soft">
              Verification runs automatically on a schedule. Metrics stay at
              zero until Agenda verifies them against the platform — they are
              never entered manually.
            </p>
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
