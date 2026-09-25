"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";

import { withdrawApplicationAction } from "@/app/dashboard/_actions/applications";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/types";

export function WithdrawApplicationButton({
  applicationId,
}: {
  applicationId: string;
}) {
  const [state, formAction, isPending] = useActionState<
    ActionResult | null,
    FormData
  >(withdrawApplicationAction, null);
  const router = useRouter();

  useEffect(() => {
    if (state?.success) {
      router.refresh();
    }
  }, [state, router]);

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="applicationId" value={applicationId} />
      <Button variant="outline" size="sm" type="submit" disabled={isPending}>
        {isPending ? "Withdrawing…" : "Withdraw"}
      </Button>
      {state && !state.success ? (
        <span className="text-xs text-danger" role="alert">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
