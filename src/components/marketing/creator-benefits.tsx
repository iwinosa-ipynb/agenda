import { SectionHeading } from "@/components/marketing/section-heading";
import {
  TargetIcon,
  TrendIcon,
  UsersIcon,
  WalletIcon,
} from "@/components/ui/icons";

const BENEFITS = [
  {
    icon: TargetIcon,
    title: "Campaigns that match you",
    body: "Filter by platform, category and location — and see the rate before you apply.",
  },
  {
    icon: TrendIcon,
    title: "Paid per verified view",
    body: "Payouts are tied to verified performance, so strong content keeps earning.",
  },
  {
    icon: WalletIcon,
    title: "Rates are transparent",
    body: "Every campaign publishes its budget and rate per 1,000 verified views up front.",
  },
  {
    icon: UsersIcon,
    title: "Grow with brands",
    body: "Build a verified track record on Agenda that advertisers can actually trust.",
  },
];

export function CreatorBenefits() {
  return (
    <section id="creators" className="scroll-mt-20 border-b border-line">
      <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
        <SectionHeading
          eyebrow="For creators"
          title="Get paid for the audience you've built."
          description="No agency gatekeeping and no vague brand deals. Find campaigns, publish, and let verified attention do the earning."
        />

        <div className="mt-14 grid gap-8 sm:grid-cols-2">
          {BENEFITS.map((benefit) => (
            <div key={benefit.title} className="flex gap-4">
              <span className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-lg border border-line bg-surface text-accent">
                <benefit.icon />
              </span>
              <div className="space-y-1.5">
                <h3 className="text-base font-semibold tracking-[-0.01em] text-ink">
                  {benefit.title}
                </h3>
                <p className="text-sm leading-relaxed text-ink-soft">
                  {benefit.body}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
