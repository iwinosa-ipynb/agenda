import { Badge } from "@/components/ui/card";
import { formatMoney } from "@/lib/utils";

const BUDGET = 500000;
const CREATOR_QUOTE = 180000;

const DETAILS = [
  { label: "Platform", value: "TikTok" },
  { label: "Category", value: "Fashion" },
  { label: "Target location", value: "Lagos" },
  { label: "Minimum followers", value: "10,000" },
  { label: "Budget", value: formatMoney(BUDGET) },
  { label: "Creator's quote", value: formatMoney(CREATOR_QUOTE) },
];

export function ExampleCampaign() {
  const milestones = [
    { label: "Draft video approved", amount: Math.round(CREATOR_QUOTE / 2) },
    { label: "Final post published", amount: CREATOR_QUOTE - Math.round(CREATOR_QUOTE / 2) },
  ];

  return (
    <section className="border-b border-line bg-ink text-canvas">
      <div className="mx-auto grid w-full max-w-6xl gap-12 px-5 py-20 sm:px-8 sm:py-24 lg:grid-cols-2 lg:gap-16">
        <div className="space-y-5">
          <p className="text-xs font-semibold tracking-[0.14em] text-accent uppercase">
            Example campaign
          </p>
          <h2 className="font-display text-3xl leading-[1.1] tracking-[-0.02em] sm:text-4xl">
            A brand brief, priced by the creator.
          </h2>
          <p className="max-w-md text-base leading-relaxed text-canvas/70">
            This is an illustration of how a campaign is structured on Agenda.
            Creators quote their own fixed fee, the brand accepts it and funds
            the agreement, and every figure below is shown before anyone
            commits.
          </p>

          <p className="max-w-md text-sm leading-relaxed text-canvas/60">
            At a {formatMoney(CREATOR_QUOTE)} agreed price, the{" "}
            {formatMoney(BUDGET)} budget leaves room for more creators — and
            the creator is paid{" "}
            <span className="font-medium text-canvas">
              {milestones.length} milestone{milestones.length === 1 ? "" : "s"}
            </span>{" "}
            as the work is confirmed.
          </p>
        </div>

        <div className="rounded-2xl border border-white/12 bg-white/[0.04] p-6 sm:p-7">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Lagos Fashion Drop</span>
            <Badge tone="accent">Active</Badge>
          </div>

          <dl className="mt-6 divide-y divide-white/10 border-t border-white/10">
            {DETAILS.map((detail) => (
              <div
                key={detail.label}
                className="flex items-center justify-between gap-6 py-3.5"
              >
                <dt className="text-sm text-canvas/60">{detail.label}</dt>
                <dd className="text-sm font-medium text-canvas">
                  {detail.value}
                </dd>
              </div>
            ))}
          </dl>

          <ul className="mt-6 space-y-2 border-t border-white/10 pt-4">
            {milestones.map((milestone) => (
              <li
                key={milestone.label}
                className="flex items-center justify-between gap-6 text-sm"
              >
                <span className="text-canvas/60">{milestone.label}</span>
                <span className="font-medium text-canvas">
                  {formatMoney(milestone.amount)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
