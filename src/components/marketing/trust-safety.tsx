import { SectionHeading } from "@/components/marketing/section-heading";
import { CheckIcon } from "@/components/ui/icons";

const COMMITMENTS = [
  "The price is the creator's own fixed quote, accepted by the brand and frozen into the agreement — it never changes after acceptance.",
  "Funds are placed with the platform before work starts, and released only as milestones are confirmed.",
  "Follower and view counts are treated as unverified until they are checked against a platform source.",
  "Every campaign publishes its budget before a creator applies, and every payout follows the agreed milestones.",
];

export function TrustSafety() {
  return (
    <section id="trust" className="scroll-mt-20">
      <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
        <SectionHeading
          eyebrow="Trust & safety"
          title="Agreed prices, funded up front."
          description="The deal on Agenda is simple: a price the creator sets, the brand accepts, and the platform holds until the work is confirmed. These are the rules the platform enforces."
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
          Agreements, funding and milestone payouts are live. Platform-verified
          view counts are shown where verification has run — as performance
          reporting, never as the basis of a creator&apos;s pay.
        </p>
      </div>
    </section>
  );
}
