import Link from "next/link";

import { buttonClasses } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { formatMoney } from "@/lib/utils";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs text-ink-faint">{label}</dt>
      <dd className="text-[15px] font-semibold text-ink">{value}</dd>
    </div>
  );
}

function ExampleCampaignCard() {
  return (
    <Card className="p-6 shadow-sm sm:p-7">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium tracking-[0.1em] text-ink-faint uppercase">
          Example campaign
        </span>
        <Badge tone="accent">Active</Badge>
      </div>

      <h2 className="mt-5 text-xl font-semibold tracking-[-0.01em] text-ink">
        Lagos Fashion Drop
      </h2>
      <p className="mt-1 text-sm text-ink-soft">TikTok · Fashion · Lagos</p>

      <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-line pt-6">
        <Stat label="Budget" value={formatMoney(500000)} />
        <Stat label="Per 1,000 views" value={formatMoney(1200)} />
        <Stat label="Min. followers" value="10,000" />
        <Stat label="Paid on" value="Verified views" />
      </dl>
    </Card>
  );
}

export function Hero() {
  return (
    <section className="border-b border-line">
      <div className="mx-auto grid w-full max-w-6xl gap-12 px-5 py-16 sm:px-8 sm:py-24 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:gap-16">
        <div className="animate-fade-up space-y-7">
          <Badge tone="accent">Creator advertising marketplace · Nigeria</Badge>

          <h1 className="font-display text-[2.75rem] leading-[1.03] tracking-[-0.03em] text-ink sm:text-6xl">
            Turn attention into income.
          </h1>

          <p className="max-w-xl text-lg leading-relaxed text-ink-soft">
            Agenda is a marketplace where brands launch campaigns and creators
            earn from verified audience attention — priced per 1,000 verified
            views, not on numbers anyone can type in.
          </p>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Link
              href="/auth/register?role=CREATOR"
              className={buttonClasses({ variant: "accent", size: "lg" })}
            >
              I&apos;m a Creator
            </Link>
            <Link
              href="/auth/register?role=ADVERTISER"
              className={buttonClasses({ variant: "outline", size: "lg" })}
            >
              I&apos;m an Advertiser
            </Link>
          </div>

          <p className="text-sm text-ink-faint">
            Free to join. No exaggerated earning promises — ever.
          </p>
        </div>

        <div className="animate-fade-up lg:pl-6">
          <ExampleCampaignCard />
        </div>
      </div>
    </section>
  );
}
