import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/dashboard/page-header";
import { Badge, Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { requireSupport } from "@/lib/authz";
import { MANAGED_BRIEF_STATUS_LABELS } from "@/lib/constants";
import { formatMoney } from "@/lib/utils";
import { listManagedBriefsForSupport } from "@/services/managed-brief.service";

export const metadata: Metadata = {
  title: "Managed briefs — review",
};

/**
 * Agenda Managed (V1, slice 2) — Support review queue.
 *
 * Support-only. `requireSupport` re-verifies role + support roster fresh from
 * the database on every request, so a revoked operator is redirected to
 * /dashboard before ANY brief is read. The service re-checks authorization
 * (defense in depth) and returns nothing for every non-support caller.
 *
 * This is an internal operational surface: it is not linked from any
 * advertiser or creator navigation, and no advertiser-facing read ever
 * includes another advertiser's brief.
 */
export default async function SupportManagedBriefsPage() {
  await requireSupport();

  const briefs = await listManagedBriefsForSupport();

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <PageHeader
        eyebrow="Support"
        title="Managed briefs"
        description="Private briefs advertisers submitted to the Agenda Managed team. Read-only here except for the review status — nothing else about a brief can be changed."
      />

      {briefs.length === 0 ? (
        <EmptyState
          title="No briefs to review"
          description="Advertiser briefs appear here the moment they are submitted."
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
                        href={`/dashboard/support/managed/${brief.id}`}
                        className="hover:text-accent hover:underline"
                      >
                        {brief.campaignGoal}
                      </Link>
                    </h2>
                    <p className="text-sm text-ink-soft">
                      {brief.advertiserCompanyName} ·{" "}
                      {formatMoney(Number(brief.budgetMinor) / 100, brief.currency)} ·{" "}
                      {brief.targetPlatforms.join(", ")}
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
