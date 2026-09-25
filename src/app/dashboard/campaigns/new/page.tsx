import type { Metadata } from "next";
import Link from "next/link";

import { CampaignForm } from "@/components/dashboard/advertiser/campaign-form";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card } from "@/components/ui/card";
import { requireRole } from "@/lib/authz";
import { DEFAULT_CURRENCY } from "@/lib/constants";
import { getCampaignBudgetGuidance } from "@/services/creator-pricing-guidance.service";

export const metadata: Metadata = {
  title: "Create campaign",
};

/**
 * Advertiser-only. requireRole redirects creators to /dashboard. Budget
 * guidance uses only real marketplace history — with an empty marketplace it
 * honestly reports insufficient data (Stage 12).
 */
export default async function NewCampaignPage() {
  await requireRole("ADVERTISER");

  // No category/platform chosen yet on a blank form, so guidance is
  // marketplace-wide and says so in its explanation.
  const guidance = await getCampaignBudgetGuidance({
    currency: DEFAULT_CURRENCY,
  });

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <Link
        href="/dashboard/campaigns"
        className="inline-flex items-center gap-1 text-sm text-ink-soft transition-colors hover:text-ink"
      >
        ← My campaigns
      </Link>

      <PageHeader
        title="Create a campaign"
        description="Fill in the details below. You can save it as a draft and publish it when everything is ready."
      />

      <Card className="p-6 sm:p-8">
        <CampaignForm budgetGuidance={guidance} />
      </Card>
    </div>
  );
}
