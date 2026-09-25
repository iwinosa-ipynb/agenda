import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  action,
  eyebrow,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-1.5">
        {eyebrow ? (
          <p className="text-xs font-semibold tracking-[0.14em] text-accent uppercase">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="font-display text-2xl tracking-[-0.02em] text-ink sm:text-3xl">
          {title}
        </h1>
        {description ? (
          <p className="max-w-2xl text-sm leading-relaxed text-ink-soft">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}
