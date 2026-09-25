import type { ReactNode } from "react";

import { FormError, FormSuccess } from "@/components/ui/messages";

// Re-exported so existing auth imports keep working from one place.
export { FormError, FormSuccess };

export function AuthFormShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="w-full max-w-md">
      <div className="mb-8 space-y-2">
        <h1 className="font-display text-3xl tracking-[-0.01em] text-ink">
          {title}
        </h1>
        {description ? (
          <p className="text-sm text-ink-soft">{description}</p>
        ) : null}
      </div>
      {children}
      {footer ? <div className="mt-6 text-sm text-ink-soft">{footer}</div> : null}
    </div>
  );
}
