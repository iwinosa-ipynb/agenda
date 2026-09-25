import Link from "next/link";

import { PageHeader } from "@/components/dashboard/page-header";
import { ApplicationStatusBadge } from "@/components/dashboard/status-badge";
import { ApplicationReviewControls } from "@/components/dashboard/advertiser/application-review-controls";
import { buttonClasses } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PLATFORM_LABELS } from "@/lib/constants";
import { formatCount, formatDate, formatMoney } from "@/lib/utils";
import {
  getViewerAdvertiser,
  listAdvertiserApplications,
} from "@/services/advertiser.service";
import type { AdvertiserApplicationSummary } from "@/types";

export async function AdvertiserApplicationsView() {
  const { profile } = await getViewerAdvertiser();
  const applications = await listAdvertiserApplications(profile.id, "ALL");

  const pending = applications.filter(
    (application) => application.status === "PENDING",
  );
  const reviewed = applications.filter(
    (application) => application.status !== "PENDING",
  );

  return (
    <div className="mx-auto w-full w-full max-w-5xl space-y-6">
      <PageHeader
        title="Applications"
        description="Creators who applied to your campaigns. Accept or reject each one."
      />

      {applications.length === 0 ? (
        <EmptyState
          title="No applications yet"
          description="When creators apply to your campaigns, their applications will appear here for review."
          action={
            <Link
              href="/dashboard/campaigns"
              className={buttonClasses({ variant: "outline", size: "sm" })}
            >
              View my campaigns
            </Link>
          }
        />
      ) : (
        <div className="space-y-8">
          <section className="space-y-4">
            <h2 className="text-sm font-semibold text-ink">
              Pending review ({pending.length})
            </h2>

            {pending.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line-strong bg-surface px-4 py-6 text-center text-sm text-ink-soft">
                Nothing waiting on you right now.
              </p>
            ) : (
              <ul className="space-y-4">
                {pending.map((application) => (
                  <li key={application.id}>
                    <ApplicationCard application={application} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {reviewed.length > 0 ? (
            <section className="space-y-4">
              <h2 className="text-sm font-semibold text-ink">
                Reviewed ({reviewed.length})
              </h2>
              <ul className="space-y-4">
                {reviewed.map((application) => (
                  <li key={application.id}>
                    <ApplicationCard application={application} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ApplicationCard({
  application,
}: {
  application: AdvertiserApplicationSummary;
}) {
  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1.5">
          <p className="text-xs text-ink-faint">
            Applied {formatDate(application.createdAt)}
          </p>
          <h3 className="text-base font-semibold tracking-[-0.01em] text-ink">
            {application.creator.name}{" "}
            <span className="font-normal text-ink-soft">
              @{application.creator.username}
            </span>
          </h3>
          <div className="flex flex-wrap gap-1.5">
            <Badge tone="muted">
              {formatCount(application.creator.followerCount)} followers ·
              self-reported
            </Badge>
            {application.creator.location ? (
              <Badge tone="muted">{application.creator.location}</Badge>
            ) : null}
            {application.creator.category ? (
              <Badge tone="muted">{application.creator.category}</Badge>
            ) : null}
          </div>
        </div>

        <ApplicationStatusBadge status={application.status} />
      </div>

      <dl className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-ink-faint">Creator&apos;s quote</dt>
          <dd className="mt-0.5 text-sm font-semibold text-ink">
            {formatMoney(application.quoteAmount, application.currency)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-faint">Campaign</dt>
          <dd className="mt-0.5 text-sm text-ink">
            <Link
              href={`/dashboard/campaigns/${application.campaign.id}`}
              className="hover:text-accent hover:underline"
            >
              {application.campaign.title}
            </Link>{" "}
            <span className="text-ink-faint">
              ({PLATFORM_LABELS[application.campaign.platform]})
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-faint">Application message</dt>
          <dd className="mt-0.5 text-sm text-ink-soft">
            {application.message ?? "No message included."}
          </dd>
        </div>
      </dl>

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <Link
          href={`/dashboard/applications/${application.id}`}
          className={buttonClasses({ variant: "outline", size: "sm" })}
        >
          View creator
        </Link>
        {application.status === "PENDING" ? (
          <ApplicationReviewControls applicationId={application.id} />
        ) : null}
      </div>
    </Card>
  );
}
