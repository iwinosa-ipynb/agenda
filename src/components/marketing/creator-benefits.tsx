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
    body: "Filter by platform, category and location — and see a campaign's budget before you apply.",
  },
  {
    icon: TrendIcon,
    title: "You set your price",
    body: "Quote your own fixed fee for every campaign. If the brand accepts it, that quote is locked in as your pay.",
  },
  {
    icon: WalletIcon,
    title: "Get paid on schedule",
    body: "Accepted quotes are funded up front and released to you as confirmed milestones are completed.",
  },
  {
    icon: UsersIcon,
    title: "Grow with brands",
    body: "Build a track record on Agenda that advertisers can actually trust.",
  },
];

export function CreatorBenefits() {
  return (
    <section id="creators" className="scroll-mt-20 border-b border-line">
      <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
        <SectionHeading
          eyebrow="For creators"
          title="Get paid what you ask for."
          description="No agency gatekeeping and no vague brand deals. Find campaigns, name your fixed fee, and get paid through funded milestones."
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
