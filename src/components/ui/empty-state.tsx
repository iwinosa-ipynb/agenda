import type { ReactNode } from "react";

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-surface px-6 py-14 text-center">
      <h3 className="text-base font-semibold tracking-[-0.01em] text-ink">
        {title}
      </h3>
      {description ? (
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-soft">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-6 flex justify-center">{action}</div> : null}
    </div>
  );
}
