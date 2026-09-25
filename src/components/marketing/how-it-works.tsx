import { SectionHeading } from "@/components/marketing/section-heading";

const STEPS = [
  {
    step: "01",
    title: "Brands launch a campaign",
    body: "Platform, category, target location, budget, and the rate paid per 1,000 verified views — all set up front.",
  },
  {
    step: "02",
    title: "Creators apply and publish",
    body: "Creators discover campaigns that fit their audience, apply, get approved, and publish the sponsored content.",
  },
  {
    step: "03",
    title: "Views are verified, creators earn",
    body: "Agenda tracks each post's performance and separates genuine attention from suspicious traffic. Payouts follow verified views.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="scroll-mt-20 border-b border-line">
      <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
        <SectionHeading
          eyebrow="How it works"
          title="A marketplace built around performance, not guesswork."
          description="Agenda connects the two sides of creator advertising with one shared metric: verified views."
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
          View verification and payouts are actively being built — see{" "}
          <a href="#trust" className="text-accent underline-offset-4 hover:underline">
            Trust &amp; safety
          </a>
          .
        </p>
      </div>
    </section>
  );
}
