import type { Metadata } from "next";

import { CreatorProfileView } from "@/components/dashboard/views/creator-profile-view";
import { AdvertiserProfileView } from "@/components/dashboard/views/advertiser-profile-view";
import { requireUser } from "@/lib/authz";

export const metadata: Metadata = {
  title: "Profile",
};

/**
 * Shared route: the profile page renders the view matching the signed-in
 * role. Role protection is enforced server-side on every request.
 */
export default async function ProfilePage() {
  const user = await requireUser();

  if (user.role === "ADVERTISER") {
    return <AdvertiserProfileView />;
  }

  return <CreatorProfileView />;
}
