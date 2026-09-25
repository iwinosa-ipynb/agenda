
import { Avatar } from "@/components/dashboard/avatar";
import { EmailVerificationStatus } from "@/components/dashboard/email-verification-status";
import { ProfileForm } from "@/components/dashboard/creator/profile-form";
import { PageHeader } from "@/components/dashboard/page-header";
import { Badge, Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { CATEGORY_LABELS } from "@/lib/constants";
import { formatCount } from "@/lib/utils";
import {
  computeProfileCompletion,
  getViewerCreator,
} from "@/services/creator.service";
import { getAccountEmailVerificationStatus } from "@/services/account-verification-status.service";

export async function CreatorProfileView() {
  const { userId, profile } = await getViewerCreator();
  const completion = computeProfileCompletion(profile);
  const verification = await getAccountEmailVerificationStatus(userId);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <PageHeader
        title="Profile"
        description="This is how advertisers will see you once campaigns open up."
      />

      <EmailVerificationStatus
        email={verification.email}
        emailVerifiedAt={verification.emailVerifiedAt}
      />

      <Card className="p-6 sm:p-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
          <Avatar name={profile.name} imageUrl={profile.profileImage} />

          <div className="min-w-0 flex-1 space-y-2">
            <div>
              <h2 className="text-lg font-semibold tracking-[-0.01em] text-ink">
                {profile.name}
              </h2>
              <p className="text-sm text-ink-soft">@{profile.username}</p>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {profile.category ? (
                <Badge tone="muted">{CATEGORY_LABELS[profile.category]}</Badge>
              ) : null}
              <Badge tone="muted">
                {formatCount(profile.followerCount)} followers · self-reported
              </Badge>
              <Badge tone="muted">
                {profile.socialAccountCount} linked{" "}
                {profile.socialAccountCount === 1 ? "account" : "accounts"}
              </Badge>
            </div>
          </div>
        </div>

        <Progress
          className="mt-6"
          value={completion.percentage}
          label="Profile completion"
        />
      </Card>

      <Card className="p-6 sm:p-8">
        <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
          Profile details
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          Your username must be unique across Agenda.
        </p>
        <div className="mt-6">
          <ProfileForm profile={profile} />
        </div>
      </Card>
    </div>
  );
}
