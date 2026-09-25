"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";

import { removeSocialAccountAction } from "@/app/dashboard/_actions/social-accounts";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/types";

export function RemoveSocialAccountButton({
  accountId,
}: {
  accountId: string;
}) {
  const [state, formAction, isPending] = useActionState<
    ActionResult | null,
    FormData
  >(removeSocialAccountAction, null);
  const router = useRouter();

  useEffect(() => {
    if (state?.success) {
      router.refresh();
    }
  }, [state, router]);

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="accountId" value={accountId} />
      <Button variant="ghost" size="sm" type="submit" disabled={isPending}>
        {isPending ? "Removing…" : "Remove"}
      </Button>
      {state && !state.success ? (
        <span className="text-xs text-danger" role="alert">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
