"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";

import { markOpportunityReadAction } from "@/app/dashboard/_actions/notifications";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/types";

/**
 * Marks one of the creator's own opportunity notifications read. The
 * notification id is the only input; ownership is enforced server-side
 * inside the service update (session-resolved creatorId), so a forged id
 * simply fails.
 */
export function MarkOpportunityReadButton({
  notificationId,
}: {
  notificationId: string;
}) {
  const [state, formAction, isPending] = useActionState<
    ActionResult | null,
    FormData
  >(markOpportunityReadAction, null);
  const router = useRouter();

  useEffect(() => {
    if (state?.success) {
      router.refresh();
    }
  }, [state, router]);

  return (
    <form action={formAction}>
      <input type="hidden" name="notificationId" value={notificationId} />
      <Button type="submit" variant="outline" size="sm" disabled={isPending}>
        {isPending ? "Marking…" : "Mark read"}
      </Button>
      {state && !state.success ? (
        <p className="mt-1 text-xs text-danger">{state.error}</p>
      ) : null}
    </form>
  );
}
