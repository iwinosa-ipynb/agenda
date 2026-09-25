import { Avatar } from "@/components/dashboard/avatar";
import { EmailVerificationStatus } from "@/components/dashboard/email-verification-status";
import { AdvertiserProfileForm } from "@/components/dashboard/advertiser/advertiser-profile-form";
import { PageHeader } from "@/components/dashboard/page-header";
import { Badge, Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  computeAdvertiserProfileCompletion,
  getViewerAdvertiser,
} from "@/services/advertiser.service";
import { getAccountEmailVerificationStatus } from "@/services/account-verification-status.service";

export async function AdvertiserProfileView() {
  const { userId, profile } = await getViewerAdvertiser();
  const completion = computeAdvertiserProfileCompletion(profile);
  const verification = await getAccountEmailVerificationStatus(userId);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <PageHeader
        title="Company profile"
        description="Creators see this information when they view your campaigns."
      />

      <EmailVerificationStatus
        email={verification.email}
        emailVerifiedAt={verification.emailVerifiedAt}
      />

      <Card className="p-6 sm:p-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
          <Avatar name={profile.companyName} imageUrl={profile.logoUrl} />

          <div className="min-w-0 flex-1 space-y-2">
            <div>
              <h2 className="text-lg font-semibold tracking-[-0.01em] text-ink">
                {profile.companyName}
              </h2>
              <p className="text-sm text-ink-soft">{profile.email}</p>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {profile.location ? (
                <Badge tone="muted">
                  {[profile.location, profile.state, profile.country]
                    .filter(Boolean)
                    .join(", ")}
                </Badge>
              ) : null}
              {profile.website ? (
                <a
                  href={profile.website}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-xs text-accent underline-offset-4 hover:underline"
                >
                  {profile.website}
                </a>
              ) : null}
            </div>
          </div>
        </div>

        <Progress
          className="mt-6"
          value={completion.percentage}
          label="Profile completion"
        />

        {completion.missing.length > 0 ? (
          <div className="mt-5 space-y-2">
            <p className="text-xs font-medium text-ink-soft">Still to add</p>
            <ul className="flex flex-wrap gap-1.5">
              {completion.missing.map((item) => (
                <li key={item}>
                  <Badge tone="muted">{item}</Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mt-5 text-sm text-accent-strong">
            Your profile is complete.
          </p>
        )}
      </Card>

      <Card className="p-6 sm:p-8">
        <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
          Company details
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          A complete profile builds trust with creators before they apply.
        </p>
        <div className="mt-6">
          <AdvertiserProfileForm profile={profile} />
        </div>
      </Card>
    </div>
  );
}
