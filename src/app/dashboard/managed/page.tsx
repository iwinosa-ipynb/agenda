import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/dashboard/page-header";
import { buttonClasses } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { requireRole } from "@/lib/authz";
import { MANAGED_BRIEF_STATUS_LABELS } from "@/lib/constants";
import { formatMoney } from "@/lib/utils";
import { getViewerAdvertiser } from "@/services/advertiser.service";
import { listManagedBriefs } from "@/services/managed-brief.service";

export const metadata: Metadata = {
  title: "Managed briefs",
};

/**
 * Advertiser-only. The service scopes every row to the signed-in advertiser's
 * profile id — the where-clause is the access rule, and no cross-advertiser
 * read exists anywhere in the service.
 */
export default async function ManagedBriefsPage() {
  await requireRole("ADVERTISER");
  const { profile } = await getViewerAdvertiser();
  const briefs = await listManagedBriefs(profile.id);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <PageHeader
        eyebrow="Agenda Managed"
        title="Managed briefs"
        description="Your private briefs to the Agenda Managed team. Only you (and Agenda's support team) can see them — they never appear in the marketplace."
        action={
          <Link href="/dashboard/managed/new" className={buttonClasses({ variant: "accent", size: "md" })}>
            New brief
          </Link>
        }
      />

      {briefs.length === 0 ? (
        <EmptyState
          title="No briefs yet"
          description="Tell us about your marketing goal, budget and audience — the Agenda Managed team takes it from there."
          action={
            <Link href="/dashboard/managed/new" className={buttonClasses({ variant: "accent" })}>
              Submit your first brief
            </Link>
          }
        />
      ) : (
        <ul className="space-y-4">
          {briefs.map((brief) => (
            <li key={brief.id}>
              <Card className="p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
                      <Link
                        href={`/dashboard/managed/${brief.id}`}
                        className="hover:text-accent hover:underline"
                      >
                        {brief.campaignGoal}
                      </Link>
                    </h2>
                    <p className="text-sm text-ink-soft">
                      {formatMoney(
                        Number(brief.budgetMinor) / 100,
                        brief.currency,
                      )}{" "}
                      ·{" "}
                      {brief.targetPlatforms
                        .map((platform) => platform)
                        .join(", ")}
                    </p>
                  </div>
                  <Badge tone="neutral">
                    {MANAGED_BRIEF_STATUS_LABELS[brief.status]}
                  </Badge>
                </div>
                <p className="mt-3 text-xs text-ink-faint">
                  Submitted {brief.createdAt.toLocaleDateString("en-GB")}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
