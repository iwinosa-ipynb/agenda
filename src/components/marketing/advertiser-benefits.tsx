import { SectionHeading } from "@/components/marketing/section-heading";
import {
  ShieldIcon,
  TargetIcon,
  TrendIcon,
  WalletIcon,
} from "@/components/ui/icons";

const BENEFITS = [
  {
    icon: ShieldIcon,
    title: "Pay agreed prices, not guesswork",
    body: "You accept each creator's fixed quote up front. The price you approve is the price you pay — funded before work starts.",
  },
  {
    icon: TargetIcon,
    title: "Reach the right creators",
    body: "Set the platform, category, location, minimum followers and budget that fit your brand.",
  },
  {
    icon: TrendIcon,
    title: "Performance you can see",
    body: "Track views, likes, comments and shares for every sponsored post in one place, with platform verification.",
  },
  {
    icon: WalletIcon,
    title: "Built for Nigerian budgets",
    body: "Campaigns are priced in naira today, with multi-currency support planned.",
  },
];

export function AdvertiserBenefits() {
  return (
    <section id="advertisers" className="scroll-mt-20 border-b border-line">
      <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
        <SectionHeading
          eyebrow="For advertisers"
          title="Spend where the attention actually is."
          description="Launch a campaign in minutes, review creators' fixed quotes, and pay agreed prices through funded milestones."
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
