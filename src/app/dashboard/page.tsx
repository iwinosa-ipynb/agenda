import { CreatorOverview } from "@/components/dashboard/creator/creator-overview";
import { AdvertiserOverview } from "@/components/dashboard/views/advertiser-overview";
import { Card } from "@/components/ui/card";
import { requireUser } from "@/lib/authz";
import {
  computeProfileCompletion,
  getCreatorDashboardStats,
  getCreatorProfile,
  getCreatorVerifiedViewSummary,
} from "@/services/creator.service";

export default async function DashboardPage() {
  const user = await requireUser();

  if (user.role === "CREATOR") {
    const profile = await getCreatorProfile(user.id);

    if (!profile) {
      return (
        <div className="mx-auto w-full max-w-2xl">
          <Card className="p-6">
            <h1 className="text-lg font-semibold text-ink">
              Creator profile missing
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              We couldn&apos;t load your creator profile. Please log out and
              back in, or contact support if this continues.
            </p>
          </Card>
        </div>
      );
    }

    const [stats, verifiedViewSummary] = await Promise.all([
      getCreatorDashboardStats(profile.id),
      // Stage 9C: server-side accounting; failure degrades to null so the
      // dashboard still renders (the summary shows "unavailable").
      getCreatorVerifiedViewSummary(profile.id).catch((error) => {
        console.error("dashboard:verified-view-summary-failed", error);
        return null;
      }),
    ]);

    return (
      <CreatorOverview
        profile={profile}
        completion={computeProfileCompletion(profile)}
        stats={stats}
        verifiedViewSummary={verifiedViewSummary}
      />
    );
  }

  return <AdvertiserOverview />;
}
