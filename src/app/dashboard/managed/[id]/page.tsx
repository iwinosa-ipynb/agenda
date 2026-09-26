import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/dashboard/page-header";
import { Badge, Card } from "@/components/ui/card";
import { requireRole } from "@/lib/authz";
import { MANAGED_BRIEF_STATUS_LABELS } from "@/lib/constants";
import { formatMajor } from "@/lib/money";
import { formatDateTime } from "@/lib/utils";
import { getViewerAdvertiser } from "@/services/advertiser.service";
import { getManagedBrief } from "@/services/managed-brief.service";

export const metadata: Metadata = {
  title: "Managed brief",
};

/**
 * Advertiser-only detail view. Ownership is inside the service query: a
 * foreign or guessed id renders not-found instead of leaking another
 * advertiser's brief. SUPPORT has its own read path (getManagedBriefForSupport)
 * behind the Stage 14D seam — this page never widens.
 */
export default async function ManagedBriefDetailPage({
  params,
}: PageProps<"/dashboard/managed/[id]">) {
  await requireRole("ADVERTISER");
  const { id } = await params;
  const { profile } = await getViewerAdvertiser();
  const brief = await getManagedBrief(profile.id, id);

  if (!brief) {
    notFound();
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <Link
        href="/dashboard/managed"
        className="inline-flex items-center gap-1 text-sm text-ink-soft transition-colors hover:text-ink"
      >
        ← Managed briefs
      </Link>

      <PageHeader
        eyebrow="Agenda Managed"
        title={brief.campaignGoal}
        description="Private brief — visible only to you and Agenda's support team."
        action={<Badge tone="neutral">{MANAGED_BRIEF_STATUS_LABELS[brief.status]}</Badge>}
      />

      <Card className="space-y-6 p-6 sm:p-8">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold tracking-[0.14em] text-accent uppercase">
            Budget &amp; channels
          </h2>
          <p className="text-sm text-ink">
            {formatMajor(BigInt(brief.budgetMinor), brief.currency)}{" "}
            {brief.currency}{" "}
            <span className="text-ink-faint">(indicative — nothing is charged)</span>
          </p>
          <p className="text-sm text-ink-soft">
            Channels: {brief.targetPlatforms.join(", ")}
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold tracking-[0.14em] text-accent uppercase">
            Target audience
          </h2>
          <p className="whitespace-pre-line text-sm leading-relaxed text-ink">
            {brief.targetAudience}
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold tracking-[0.14em] text-accent uppercase">
            Campaign description
          </h2>
          <p className="whitespace-pre-line text-sm leading-relaxed text-ink">
            {brief.description}
          </p>
        </section>

        {brief.creatorRequirements ? (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold tracking-[0.14em] text-accent uppercase">
              Creator requirements
            </h2>
            <p className="whitespace-pre-line text-sm leading-relaxed text-ink">
              {brief.creatorRequirements}
            </p>
          </section>
        ) : null}

        <p className="border-t border-line pt-4 text-xs text-ink-faint">
          Submitted {formatDateTime(brief.createdAt)} · Last updated{" "}
          {formatDateTime(brief.updatedAt)}
        </p>
      </Card>
    </div>
  );
}
