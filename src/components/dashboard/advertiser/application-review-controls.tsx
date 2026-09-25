"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";

import { reviewApplicationAction } from "@/app/dashboard/_actions/advertiser";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/types";

/**
 * Accept / reject buttons for one pending application. The action re-verifies
 * the application → campaign → advertiser ownership chain server-side.
 */
export function ApplicationReviewControls({
  applicationId,
}: {
  applicationId: string;
}) {
  const [state, formAction, isPending] = useActionState<
    ActionResult | null,
    FormData
  >(reviewApplicationAction, null);
  const router = useRouter();

  useEffect(() => {
    if (state?.success) {
      router.refresh();
    }
  }, [state, router]);

  return (
    <div className="flex items-center gap-2">
      <form action={formAction}>
        <input type="hidden" name="applicationId" value={applicationId} />
        <input type="hidden" name="decision" value="ACCEPT" />
        <Button
          variant="accent"
          size="sm"
          type="submit"
          disabled={isPending}
        >
          {isPending ? "Working…" : "Accept"}
        </Button>
      </form>
      <form action={formAction}>
        <input type="hidden" name="applicationId" value={applicationId} />
        <input type="hidden" name="decision" value="REJECT" />
        <Button variant="outline" size="sm" type="submit" disabled={isPending}>
          Reject
        </Button>
      </form>

      {state && !state.success ? (
        <span className="text-xs text-danger" role="alert">
          {state.error}
        </span>
      ) : null}
    </div>
  );
}
