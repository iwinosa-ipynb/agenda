import { SectionHeading } from "@/components/marketing/section-heading";

const STEPS = [
  {
    step: "01",
    title: "Brands launch a campaign",
    body: "Platform, category, target location, budget, and the deliverables — all set up front. No hidden rates.",
  },
  {
    step: "02",
    title: "Creators quote, brands accept",
    body: "Creators apply with their own fixed price for the campaign. When a brand accepts, that quote becomes the agreed price.",
  },
  {
    step: "03",
    title: "Work is funded and paid out",
    body: "The brand funds the agreement up front. As milestones are confirmed, the agreed amounts are released to the creator.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="scroll-mt-20 border-b border-line">
      <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
        <SectionHeading
          eyebrow="How it works"
          title="A marketplace built around agreed prices, not guesswork."
          description="Agenda connects the two sides of creator advertising on one simple basis: a fixed price the creator names and the brand accepts."
        />

        <ol className="mt-14 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3">
          {STEPS.map((item) => (
            <li key={item.step} className="bg-surface p-7">
              <span className="font-mono text-xs tracking-widest text-accent">
                {item.step}
              </span>
              <h3 className="mt-5 text-lg font-semibold tracking-[-0.01em] text-ink">
                {item.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                {item.body}
              </p>
            </li>
          ))}
        </ol>

        <p className="mt-6 text-sm text-ink-faint">
          Payments, agreements and milestone payouts are live — see{" "}
          <a href="#trust" className="text-accent underline-offset-4 hover:underline">
            Trust &amp; safety
          </a>
          .
        </p>
      </div>
    </section>
  );
}
