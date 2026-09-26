import type { Metadata } from "next";
import Link from "next/link";

import { ManagedBriefForm } from "@/components/dashboard/advertiser/managed-brief-form";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card } from "@/components/ui/card";
import { requireRole } from "@/lib/authz";

export const metadata: Metadata = {
  title: "Managed brief",
};

/**
 * Advertiser-only. requireRole redirects creators (and SUPPORT) to the
 * dashboard. The brief is submitted to Agenda Managed, not to the public
 * marketplace — no creator ever sees it.
 */
export default async function NewManagedBriefPage() {
  await requireRole("ADVERTISER");

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
        title="Tell us about your marketing"
        description="Submit a private brief and the Agenda Managed team takes it from here — sourcing, planning and running the campaign for you. Nothing in this brief is visible to creators or the marketplace."
      />

      <Card className="p-6 sm:p-8">
        <ManagedBriefForm />
      </Card>
    </div>
  );
}
