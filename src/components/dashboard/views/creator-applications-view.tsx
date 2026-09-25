import Link from "next/link";

import { WithdrawApplicationButton } from "@/components/dashboard/creator/withdraw-application-button";
import { PageHeader } from "@/components/dashboard/page-header";
import { ApplicationStatusBadge } from "@/components/dashboard/status-badge";
import { buttonClasses } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PLATFORM_LABELS } from "@/lib/constants";
import { formatDate, formatMoney } from "@/lib/utils";
import { listCreatorApplications } from "@/services/application.service";
import { requireViewerCreatorId } from "@/services/creator.service";

export async function CreatorApplicationsView() {
  const creatorId = await requireViewerCreatorId();
  const applications = await listCreatorApplications(creatorId);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <PageHeader
        title="My applications"
        description="Every campaign you've applied to, and where each application stands."
      />

      {applications.length === 0 ? (
        <EmptyState
          title="No applications yet"
          description="Find a campaign that fits your audience and apply — your applications will show up here."
          action={
            <Link
              href="/dashboard/campaigns"
              className={buttonClasses({ variant: "accent", size: "sm" })}
            >
              Find campaigns
            </Link>
          }
        />
      ) : (
        <ul className="space-y-4">
          {applications.map((application) => (
            <li key={application.id}>
              <Card className="p-5 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 space-y-1.5">
                    <p className="text-xs text-ink-faint">
                      {application.advertiser.companyName}
                    </p>
                    <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
                      {application.campaign.title}
                    </h2>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge tone="muted">
                        {PLATFORM_LABELS[application.campaign.platform]}
                      </Badge>
                      <Badge tone="muted">
                        Applied {formatDate(application.createdAt)}
                      </Badge>
                    </div>
                  </div>

                  <ApplicationStatusBadge status={application.status} />
                </div>

                {application.message ? (
                  <p className="mt-4 rounded-lg bg-surface-muted px-3.5 py-2.5 text-sm leading-relaxed text-ink-soft">
                    {application.message}
                  </p>
                ) : null}

                <p className="mt-4 text-sm text-ink">
                  <span className="text-ink-soft">Your requested fee:</span>{" "}
                  <span className="font-semibold">
                    {formatMoney(
                      application.quoteAmount,
                      application.currency,
                    )}
                  </span>
                </p>

                <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
                  <Link
                    href={`/dashboard/campaigns/${application.campaign.id}`}
                    className={buttonClasses({ variant: "outline", size: "sm" })}
                  >
                    View campaign
                  </Link>
                  {application.status === "PENDING" ? (
                    <WithdrawApplicationButton applicationId={application.id} />
                  ) : null}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
