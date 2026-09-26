import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/dashboard/page-header";
import { MilestoneCard } from "@/components/dashboard/milestone-card";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { requireUser } from "@/lib/authz";
import { formatMoney } from "@/lib/utils";
import { formatMajor } from "@/lib/money";
import { AGREEMENT_STATUS_LABELS } from "@/lib/constants";
import { getViewerAdvertiser } from "@/services/advertiser.service";
import { getViewerCreator } from "@/services/creator.service";
import { listMilestonesForParty } from "@/services/payments/milestone.service";
import { getFundingStatusForAdvertiser } from "@/services/payments/funding.service";
import { FundingPreparationForm } from "@/components/dashboard/advertiser/funding-preparation-form";
import { PaymentInitiationForm } from "@/components/dashboard/advertiser/payment-initiation-form";
import { listAdvertiserAgreements, listCreatorAgreements } from "@/services/agreement.service";
import type { CampaignAgreementSummary } from "@/types";

export const metadata: Metadata = {
  title: "Agreements",
};

/**
 * Stage 13B/14A — the milestone home for both parties. Advertisers see their
 * agreements with review controls plus the funding status of each agreement;
 * creators see theirs with correction controls. Milestone independence is
 * visible here: each milestone carries its own status and none of them
 * freezes its siblings.
 */
export default async function AgreementsPage() {
  const user = await requireUser();
  const isAdvertiser = user.role === "ADVERTISER";

  const agreements: Array<{
    agreement: CampaignAgreementSummary;
    milestones: NonNullable<Awaited<ReturnType<typeof listMilestonesForParty>>>;
    /** Stage 14A: the advertiser's funding state for this agreement (null for creators). */
    funding: Awaited<ReturnType<typeof getFundingStatusForAdvertiser>>;
  }> = [];

  if (isAdvertiser) {
    const { profile } = await getViewerAdvertiser();
    const rows = await listAdvertiserAgreements(profile.id);

    for (const agreement of rows) {
      const [milestones, funding] = await Promise.all([
        listMilestonesForParty(agreement.id, {
          advertiserId: profile.id,
        }),
        getFundingStatusForAdvertiser(agreement.id, profile.id),
      ]);

      agreements.push({
        agreement,
        milestones: milestones ?? [],
        funding,
      });
    }
  } else {
    const { profile } = await getViewerCreator();
    const rows = await listCreatorAgreements(profile.id);

    for (const theAgreement of rows) {
      const milestones = await listMilestonesForParty(theAgreement.id, {
        creatorId: profile.id,
      });

      agreements.push({
        agreement: theAgreement,
        milestones: milestones ?? [],
        funding: null,
      });
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
        agreements.map(({ agreement, milestones, funding }) => {
          const obligation = funding?.obligation ?? null;
          // PENDING_PAYMENT means the obligation exists but NO money has been
          // verified — the honest state until a Stage 14B provider confirms.
          const awaitingPayment = obligation !== null && !obligation.escrowFunded;

          return (
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

              {awaitingPayment && obligation ? (
                <div className="mt-4 rounded-lg border border-dashed border-warning-strong/30 bg-warning-soft px-3.5 py-3 text-xs leading-relaxed text-ink-soft">
                  <p className="font-medium text-ink">
                    Awaiting payment — no money has been taken yet.
                  </p>
                  <p className="mt-1">
                    Funding is prepared for this agreement (ref{" "}
                    {obligation.obligationRef}). The creator amount is{" "}
                    {formatMajor(obligation.creatorAmountMinor, obligation.currency)}{" "}
                    {obligation.currency} plus a{" "}
                    {formatMajor(obligation.platformFeeMinor, obligation.currency)}{" "}
                    {obligation.currency} platform service fee — a total of{" "}
                    {formatMajor(obligation.advertiserTotalMinor, obligation.currency)}{" "}
                    {obligation.currency}. Milestones unlock for delivery only
                    once the payment provider verifies the funds.
                  </p>
                </div>
              ) : null}

              {/* Stage 14B: the Paystack entry point — only while the
                  obligation still awaits payment (PENDING_PAYMENT). */}
              {isAdvertiser && obligation !== null && obligation.status === "PENDING_PAYMENT" ? (
                <PaymentInitiationForm
                  obligationId={obligation.id}
                  creatorAmountMinor={obligation.creatorAmountMinor}
                  platformFeeMinor={obligation.platformFeeMinor}
                  advertiserTotalMinor={obligation.advertiserTotalMinor}
                  currency={obligation.currency}
                />
              ) : null}

              {milestones.length === 0 ? (
                isAdvertiser && obligation === null ? (
                  <FundingPreparationForm
                    agreementId={agreement.id}
                    agreedAmount={agreement.agreedAmount}
                    currency={agreement.currency}
                  />
                ) : (
                  <p className="mt-4 rounded-lg border border-dashed border-line-strong bg-surface-muted px-3.5 py-3 text-xs leading-relaxed text-ink-soft">
                    Milestones are defined when funding is prepared for this
                    agreement.
                  </p>
                )
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
          );
        })
      )}
    </div>
  );
}
