import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ApplicationReviewControls } from "@/components/dashboard/advertiser/application-review-controls";
import { Avatar } from "@/components/dashboard/avatar";
import { PageHeader } from "@/components/dashboard/page-header";
import {
  ApplicationStatusBadge,
  SocialAccountStatusBadge,
} from "@/components/dashboard/status-badge";
import { buttonClasses } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { CATEGORY_LABELS, PLATFORM_LABELS } from "@/lib/constants";
import { formatCount, formatDate, formatMoney } from "@/lib/utils";
import { requireRole } from "@/lib/authz";
import {
  getCreatorForReview,
  getViewerAdvertiser,
} from "@/services/advertiser.service";

type ReviewParams = PageProps<"/dashboard/applications/[id]">;

export const metadata: Metadata = {
  title: "Review application",
};

/**
 * Advertiser-only creator review. Access is justified by the application:
 * the service only returns the creator when the application belongs to a
 * campaign owned by the signed-in advertiser.
 */
export default async function CreatorReviewPage({ params }: ReviewParams) {
  await requireRole("ADVERTISER");

  const { id } = await params;
  const { profile } = await getViewerAdvertiser();
  const result = await getCreatorForReview(profile.id, id);

  if (!result) {
    notFound();
  }

  const { application, creator } = result;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <Link
        href="/dashboard/applications"
        className="inline-flex items-center gap-1 text-sm text-ink-soft transition-colors hover:text-ink"
      >
        ← All applications
      </Link>

      <PageHeader
        eyebrow={`Applied to ${application.campaign.title}`}
        title={`${creator.name} (@${creator.username})`}
        description={`Applied ${formatDate(application.createdAt)}`}
        action={<ApplicationStatusBadge status={application.status} />}
      />

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr] lg:items-start">
        <div className="space-y-6">
          <Card className="p-6 sm:p-8">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
              <Avatar name={creator.name} imageUrl={creator.profileImage} />

              <div className="min-w-0 flex-1 space-y-2">
                <h2 className="text-lg font-semibold tracking-[-0.01em] text-ink">
                  {creator.name}
                </h2>
                <p className="text-sm text-ink-soft">@{creator.username}</p>
                <div className="flex flex-wrap gap-1.5">
                  {creator.category ? (
                    <Badge tone="muted">
                      {CATEGORY_LABELS[creator.category]}
                    </Badge>
                  ) : null}
                  <Badge tone="muted">
                    {formatCount(creator.followerCount)} followers ·
                    self-reported
                  </Badge>
                </div>
              </div>
            </div>

            <dl className="mt-6 divide-y divide-line border-t border-line">
              <Fact
                label="Bio"
                value={creator.bio ?? "No bio added yet."}
              />
              <Fact
                label="Location"
                value={
                  [creator.location, creator.state, creator.country]
                    .filter(Boolean)
                    .join(", ") || "Not provided"
                }
              />
              <Fact
                label="Category"
                value={
                  creator.category ? CATEGORY_LABELS[creator.category] : "—"
                }
              />
              <Fact
                label="Follower count"
                value={`${formatCount(creator.followerCount)} — self-reported / unverified`}
              />
            </dl>

            <p className="mt-4 rounded-lg border border-dashed border-line-strong bg-surface-muted px-3.5 py-3 text-xs leading-relaxed text-ink-soft">
              Follower counts are what creators tell us about themselves. Real
              platform verification isn&apos;t connected yet, so treat these as
              unverified until official APIs are integrated.
            </p>
          </Card>

          <Card className="p-6 sm:p-8">
            <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
              Creator&apos;s listed rates
            </h2>
            <p className="mt-1 text-sm text-ink-soft">
              The creator&apos;s own starting prices — a reference, not a fixed
              price. Their offer for this campaign is the quote in your
              application panel.
            </p>

            {creator.rateCard.length === 0 ? (
              <p className="mt-3 text-sm text-ink-soft">
                This creator hasn&apos;t published a rate card yet.
              </p>
            ) : (
              <ul className="mt-4 divide-y divide-line">
                {creator.rateCard.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-baseline justify-between gap-2 py-3"
                  >
                    <span className="text-sm text-ink">
                      {PLATFORM_LABELS[item.platform]} ·{" "}
                      {item.serviceType}
                    </span>
                    <span className="text-sm font-medium text-ink">
                      {formatMoney(item.price, item.currency)}
                    </span>
                    {item.description ? (
                      <span className="w-full text-xs text-ink-faint">
                        {item.description}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-6 sm:p-8">
            <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
              Connected social accounts
            </h2>

            {creator.socialAccounts.length === 0 ? (
              <p className="mt-3 text-sm text-ink-soft">
                This creator hasn&apos;t linked any social accounts yet.
              </p>
            ) : (
              <ul className="mt-4 divide-y divide-line">
                {creator.socialAccounts.map((account) => (
                  <li
                    key={account.id}
                    className="flex flex-wrap items-center justify-between gap-4 py-4"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-ink">
                          {PLATFORM_LABELS[account.platform]}
                        </span>
                        <SocialAccountStatusBadge status={account.status} />
                      </div>
                      <p className="truncate text-sm text-ink-soft">
                        @{account.username}
                      </p>
                      {account.followerCount !== null ? (
                        <p className="text-xs text-ink-faint">
                          {formatCount(account.followerCount)} followers ·
                          self-reported
                        </p>
                      ) : (
                        <p className="text-xs text-ink-faint">
                          Follower count pending platform verification
                        </p>
                      )}
                    </div>

                    <a
                      href={account.profileUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className={buttonClasses({
                        variant: "outline",
                        size: "sm",
                      })}
                    >
                      View profile
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <aside className="space-y-6">
          <Card className="p-6">
            <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
              Application
            </h2>

            <div className="mt-4 space-y-3">
              <ApplicationStatusBadge status={application.status} />
              <div className="rounded-lg border border-accent/25 bg-accent-soft px-3.5 py-3">
                <p className="text-xs text-accent-strong/80">Creator&apos;s quote</p>
                <p className="text-lg font-semibold text-accent-strong">
                  {formatMoney(application.quoteAmount, application.currency)}
                </p>
                <p className="mt-1 text-xs text-accent-strong/80">
                  If you accept, this becomes the creator&apos;s guaranteed fee.
                </p>
              </div>
              <p className="text-sm leading-relaxed text-ink-soft">
                {application.message ?? "No message was included."}
              </p>
              <Link
                href={`/dashboard/campaigns/${application.campaign.id}`}
                className={buttonClasses({ variant: "outline", size: "sm" })}
              >
                View campaign
              </Link>
            </div>
          </Card>

          {application.status === "PENDING" ? (
            <Card className="p-6">
              <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
                Decision
              </h2>
              <p className="mt-1 text-sm text-ink-soft">
                Accepted creators will see this campaign under their active
                campaigns.
              </p>
              <div className="mt-4">
                <ApplicationReviewControls applicationId={application.id} />
              </div>
            </Card>
          ) : null}
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
