import type { Metadata } from "next";
import Link from "next/link";

import { MarkOpportunityReadButton } from "@/components/dashboard/creator/mark-opportunity-read-button";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card } from "@/components/ui/card";
import { requireRole } from "@/lib/authz";
import { CATEGORY_LABELS, PLATFORM_LABELS } from "@/lib/constants";
import { formatDate, formatMoney } from "@/lib/utils";
import { getViewerCreator } from "@/services/creator.service";
import { listCreatorOpportunities } from "@/services/notifications.service";

export const metadata: Metadata = {
  title: "Opportunities",
};

const REASON_LABELS: Record<string, string> = {
  platform_match: "Your platform",
  category_match: "Your category",
  location_match: "Your location",
  audience_size: "Your audience size",
};

/**
 * Creator-only opportunity feed. Rows are created exclusively by the
 * server-side publication flow (relevance matching); this page only reads
 * the signed-in creator's OWN notifications — the creatorId is
 * session-resolved and ownership rides inside the service query.
 *
 * An opportunity is NOT eligibility: the campaign card links to the normal
 * campaign detail page where `applyToCampaign` remains the single
 * authoritative application gate.
 */
export default async function OpportunitiesPage() {
  await requireRole("CREATOR");
  const { profile } = await getViewerCreator();

  const { opportunities, unread } = await listCreatorOpportunities(profile.id);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <PageHeader
        title="Opportunities"
        description={
          unread > 0
            ? `${unread} new opportunit${unread === 1 ? "y" : "ies"} matched to your profile.`
            : "Campaigns matched to your profile, newest first."
        }
      />

      {opportunities.length === 0 ? (
        <Card className="p-6 sm:p-8">
          <p className="text-sm text-ink-soft">
            No opportunities yet. When a published campaign matches your
            platform, category or location, it shows up here — you always set
            your own fixed price if you apply.
          </p>
        </Card>
      ) : (
        <ul className="space-y-4">
          {opportunities.map((opportunity) => (
            <li key={opportunity.id}>
              <Card
                className={`p-5 sm:p-6 ${
                  opportunity.readAt === null
                    ? "border-accent/40 bg-accent-soft/30"
                    : ""
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/dashboard/campaigns/${opportunity.campaign.id}`}
                        className="text-sm font-medium text-ink hover:underline"
                      >
                        {opportunity.campaign.title}
                      </Link>
                      {opportunity.readAt === null ? (
                        <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-white">
                          New
                        </span>
                      ) : null}
                    </div>
                    <p className="text-xs text-ink-faint">
                      {opportunity.campaign.advertiserName} ·{" "}
                      {PLATFORM_LABELS[
                        opportunity.campaign.platform as keyof typeof PLATFORM_LABELS
                      ] ?? opportunity.campaign.platform}{" "}
                      ·{" "}
                      {CATEGORY_LABELS[
                        opportunity.campaign.category as keyof typeof CATEGORY_LABELS
                      ] ?? opportunity.campaign.category}{" "}
                      ·{" "}
                      {formatMoney(
                        opportunity.campaign.budget,
                        opportunity.campaign.currency,
                      )}{" "}
                      budget
                    </p>
                    <p className="text-xs text-ink-faint">
                      Why it matches you:{" "}
                      {opportunity.reasons
                        .map(
                          (reason) =>
                            REASON_LABELS[reason] ?? reason,
                        )
                        .join(" · ")}
                    </p>
                    <p className="text-xs text-ink-faint">
                      {opportunity.campaign.applicationDeadline
                        ? `Applications close ${formatDate(opportunity.campaign.applicationDeadline)}`
                        : "Open until filled"}
                      {" · "}
                      Matched {formatDate(opportunity.createdAt)}
                    </p>
                  </div>

                  {opportunity.readAt === null ? (
                    <MarkOpportunityReadButton
                      notificationId={opportunity.id}
                    />
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
