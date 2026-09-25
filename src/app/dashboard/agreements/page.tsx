import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/dashboard/page-header";
import { MilestoneCard } from "@/components/dashboard/milestone-card";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { requireUser } from "@/lib/authz";
import { formatMoney } from "@/lib/utils";
import { AGREEMENT_STATUS_LABELS } from "@/lib/constants";
import { getViewerAdvertiser } from "@/services/advertiser.service";
import { getViewerCreator } from "@/services/creator.service";
import { listMilestonesForParty } from "@/services/payments/milestone.service";
import { listAdvertiserAgreements, listCreatorAgreements } from "@/services/agreement.service";
import type { CampaignAgreementSummary } from "@/types";

export const metadata: Metadata = {
  title: "Agreements",
};

/**
 * Stage 13B — the milestone home for both parties. Advertisers see their
 * agreements with review controls; creators see theirs with correction
 * controls. Milestone independence is visible here: each milestone carries
 * its own status and none of them freezes its siblings.
 */
export default async function AgreementsPage() {
  const user = await requireUser();
  const isAdvertiser = user.role === "ADVERTISER";

  const agreements: Array<{
    agreement: CampaignAgreementSummary;
    milestones: NonNullable<Awaited<ReturnType<typeof listMilestonesForParty>>>;
  }> = [];

  if (isAdvertiser) {
    const { profile } = await getViewerAdvertiser();
    const rows = await listAdvertiserAgreements(profile.id);

    for (const agreement of rows) {
      const milestones = await listMilestonesForParty(agreement.id, {
        advertiserId: profile.id,
      });

      agreements.push({ agreement, milestones: milestones ?? [] });
    }
  } else {
    const { profile } = await getViewerCreator();
    const rows = await listCreatorAgreements(profile.id);

    for (const theAgreement of rows) {
      const milestones = await listMilestonesForParty(theAgreement.id, {
        creatorId: profile.id,
      });

      agreements.push({ agreement: theAgreement, milestones: milestones ?? [] });
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <PageHeader
        title="Agreements"
        description="Accepted collaborations, their frozen terms, and each milestone's review & payment status. Funding is verified before any milestone can enter review; nothing is ever released automatically."
      />

      {agreements.length === 0 ? (
        <EmptyState
          title="No agreements yet"
          description={
            isAdvertiser
              ? "When you accept a creator's application, the agreed terms are frozen here and milestones appear for review."
              : "When an advertiser accepts your application, the agreed terms are frozen here and your milestones appear."
          }
        />
      ) : (
        agreements.map(({ agreement, milestones }) => (
          <Card key={agreement.id} className="p-6 sm:p-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <p className="text-xs text-ink-faint">
                  {isAdvertiser
                    ? `@${agreement.creator.username}`
                    : agreement.advertiser.companyName}
                </p>
                <h2 className="text-lg font-semibold tracking-[-0.01em] text-ink">
                  <Link
                    href={`/dashboard/campaigns/${agreement.campaign.id}`}
                    className="hover:text-accent hover:underline"
                  >
                    {agreement.campaign.title}
                  </Link>
                </h2>
                <p className="text-sm text-ink-soft">
                  Agreed {formatMoney(agreement.agreedAmount, agreement.currency)} ·{" "}
                  {AGREEMENT_STATUS_LABELS[agreement.status]} · accepted{" "}
                  {agreement.acceptedAt.toLocaleDateString("en-GB")}
                </p>
              </div>
            </div>

            {milestones.length === 0 ? (
              <p className="mt-4 rounded-lg border border-dashed border-line-strong bg-surface-muted px-3.5 py-3 text-xs leading-relaxed text-ink-soft">
                Milestones are defined when funding is prepared for this
                agreement.
              </p>
            ) : (
              <ul className="mt-5 space-y-4">
                {milestones.map((milestone) => (
                  <li key={milestone.id}>
                    <MilestoneCard milestone={milestone} viewer={isAdvertiser ? "ADVERTISER" : "CREATOR"} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ))
      )}
    </div>
  );
}
