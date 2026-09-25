import { SectionHeading } from "@/components/marketing/section-heading";
import { CheckIcon } from "@/components/ui/icons";

const COMMITMENTS = [
  "Payouts are designed to be calculated server-side from verified views — never from a number a user submits.",
  "Follower counts and view counts are treated as unverified until they are checked against a platform source.",
  "Suspicious, farmed or bot traffic is separated out before any amount becomes payable.",
  "Every campaign publishes its rate and budget before a creator applies.",
];

export function TrustSafety() {
  return (
    <section id="trust" className="scroll-mt-20">
      <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
        <SectionHeading
          eyebrow="Trust & safety"
          title="Verified attention or nothing."
          description="The whole point of Agenda is that money only moves when real people watched. These are the rules the platform is being built to enforce."
        />

        <ul className="mt-14 grid gap-x-10 gap-y-6 sm:grid-cols-2">
          {COMMITMENTS.map((commitment) => (
            <li key={commitment} className="flex gap-3.5">
              <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-strong">
                <CheckIcon className="size-3.5" />
              </span>
              <p className="text-sm leading-relaxed text-ink-soft">
                {commitment}
              </p>
            </li>
          ))}
        </ul>

        <p className="mt-10 max-w-2xl rounded-xl border border-line bg-surface-muted p-5 text-sm leading-relaxed text-ink-soft">
          <span className="font-medium text-ink">Where we are today:</span>{" "}
          Agenda&apos;s foundation is live. Platform API integrations, antifraud
          scoring and payments are not implemented yet, so no view counted in
          the product is currently presented as verified.
        </p>
      </div>
    </section>
  );
}
