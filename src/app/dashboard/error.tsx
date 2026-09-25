"use client";

import { buttonClasses } from "@/components/ui/button";

/**
 * Route-level error boundary for the dashboard (Stage 9C, Task 7). A failed
 * service/database call — e.g. loading verified-view data — must not render a
 * broken page: the user gets a calm retry affordance instead.
 */
export default function DashboardError({
  reset,
}: {
  // Next's error-boundary contract passes the Error; it is intentionally not
  // rendered here because it can carry internal implementation details.
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-2xl py-16">
      <div className="rounded-xl border border-dashed border-line-strong bg-surface px-6 py-14 text-center">
        <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
          Something went wrong
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-soft">
          We couldn&apos;t load this part of your dashboard. This is usually
          temporary — try again.
        </p>
        <button
          type="button"
          onClick={reset}
          className={buttonClasses({ variant: "outline", size: "sm", className: "mt-6" })}
        >
          Try again
        </button>
      </div>
    </div>
  );
}
