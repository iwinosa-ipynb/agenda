import type { Metadata } from "next";

import { RateCardItemCard } from "@/components/dashboard/creator/rate-card-item-card";
import { RateCardForm } from "@/components/dashboard/creator/rate-card-form";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { getViewerCreator } from "@/services/creator.service";
import { listRateCardItems } from "@/services/rate-card.service";

export const metadata: Metadata = {
  title: "Rate card",
};

/**
 * Creator rate-card management (Stage 12).
 *
 * Copy rules from the brief, enforced here in one place:
 *   - The listed rate is a STARTING REFERENCE for advertisers, nothing more.
 *   - The final price is the per-campaign quote the creator submits and the
 *     advertiser accepts.
 *   - Agenda has no "market rate" at launch and never claims one.
 */
export default async function RateCardPage() {
  const { profile } = await getViewerCreator();
  const items = await listRateCardItems(profile.id);

  const active = items.filter((item) => item.status === "ACTIVE");
  const history = items.filter((item) => item.status === "INACTIVE");

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <PageHeader
        title="Rate card"
        description="Your listed starting rates for advertisers to reference."
      />

      <Card className="p-6 sm:p-8">
        <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
          How your rate card works
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          Your listed rate is a starting reference for advertisers. Your final
          campaign price is determined by the quote you submit and the terms
          accepted for that campaign.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          You set your own prices. Agenda doesn&apos;t tell you what the
          &ldquo;market rate&rdquo; is — there is no market data yet, so we
          won&apos;t pretend otherwise. Quote what your work is worth.
        </p>
      </Card>

      <Card className="p-6 sm:p-8">
        <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
          Add a rate
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          One rate per platform and content type. Editing a rate keeps the old
          version in your history.
        </p>
        <div className="mt-6">
          <RateCardForm />
        </div>
      </Card>

      <Card className="p-6 sm:p-8">
        <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
          Your rates
        </h2>

        {active.length === 0 ? (
          <div className="mt-6">
            <EmptyState
              title="No active rates yet"
              description="Add your listed rates so advertisers can see your starting prices. You decide every final price when you quote a campaign."
            />
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-line">
            {active.map((item) => (
              <RateCardItemCard key={item.id} item={item} />
            ))}
          </ul>
        )}
      </Card>

      {history.length > 0 ? (
        <Card className="p-6 sm:p-8">
          <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
            Rate history
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            Previous versions of your rates. Reactivate one to bring it back.
          </p>
          <ul className="mt-4 divide-y divide-line">
            {history.map((item) => (
              <RateCardItemCard key={item.id} item={item} />
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
