import { Badge } from "@/components/ui/card";
import { formatMoney } from "@/lib/utils";

const BUDGET = 500000;
const RATE_PER_THOUSAND = 1200;

const DETAILS = [
  { label: "Platform", value: "TikTok" },
  { label: "Category", value: "Fashion" },
  { label: "Target location", value: "Lagos" },
  { label: "Minimum followers", value: "10,000" },
  { label: "Budget", value: formatMoney(BUDGET) },
  { label: "Rate", value: `${formatMoney(RATE_PER_THOUSAND)} / 1,000 views` },
];

export function ExampleCampaign() {
  const coveredViews = Math.floor((BUDGET / RATE_PER_THOUSAND) * 1000);

  return (
    <section className="border-b border-line bg-ink text-canvas">
      <div className="mx-auto grid w-full max-w-6xl gap-12 px-5 py-20 sm:px-8 sm:py-24 lg:grid-cols-2 lg:gap-16">
        <div className="space-y-5">
          <p className="text-xs font-semibold tracking-[0.14em] text-accent uppercase">
            Example campaign
          </p>
          <h2 className="font-display text-3xl leading-[1.1] tracking-[-0.02em] sm:text-4xl">
            A brand brief, priced per verified view.
          </h2>
          <p className="max-w-md text-base leading-relaxed text-canvas/70">
            This is an illustration of how a campaign is structured on Agenda.
            Budgets and payouts are priced on verified views, and every figure
            below is shown to creators before they apply.
          </p>

          <p className="max-w-md text-sm leading-relaxed text-canvas/60">
            At {formatMoney(RATE_PER_THOUSAND)} per 1,000 verified views, a{" "}
            {formatMoney(BUDGET)} budget covers roughly{" "}
            <span className="font-medium text-canvas">
              {coveredViews.toLocaleString("en-NG")}
            </span>{" "}
            verified views.
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
        </div>
      </div>
    </section>
  );
}
