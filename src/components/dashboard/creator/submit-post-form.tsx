"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";

import { submitCampaignPostAction } from "@/app/dashboard/_actions/posts";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormError } from "@/components/ui/messages";
import { SubmitButton } from "@/components/ui/submit-button";
import { POST_PLATFORMS, PLATFORM_LABELS } from "@/lib/constants";
import type { ActionResult } from "@/types";

export function SubmitPostForm({ campaignId }: { campaignId: string }) {
  const [state, formAction] = useActionState<
    ActionResult | null,
    FormData
  >(submitCampaignPostAction, null);
  const router = useRouter();

  useEffect(() => {
    if (state?.success) {
      router.refresh();
    }
  }, [state, router]);

  // The confirmation state mirrors the apply-to-campaign pattern: after a
  // successful submit the form is replaced by a summary of what was recorded.
  if (state?.success) {
    return (
      <div className="space-y-4">
        <div
          role="status"
          className="rounded-lg border border-accent/25 bg-accent-soft px-3.5 py-3 text-sm font-medium text-accent-strong"
        >
          Content submitted
        </div>
        <p className="text-sm leading-relaxed text-ink-soft">
          Agenda has recorded your submission. Platform verification runs on a
          schedule — once it completes, your post&apos;s verified views are shown
          under My posts.
        </p>
        <p className="text-sm leading-relaxed text-ink-soft">
          You can track the status of your submission under{" "}
          <a
            href="/dashboard/posts"
            className="font-medium text-accent underline-offset-4 hover:underline"
          >
            My posts
          </a>
          .
        </p>
      </div>
    );
  }

  const fieldErrors = state && !state.success ? (state.fieldErrors ?? {}) : {};

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="campaignId" value={campaignId} />

      <FormError message={state && !state.success ? state.error : null} />

      <Field
        label="Platform"
        htmlFor="platform"
        hint="Where you published the content."
        error={fieldErrors.platform?.[0]}
      >
        <Select
          id="platform"
          name="platform"
          defaultValue={POST_PLATFORMS[0]}
          invalid={Boolean(fieldErrors.platform)}
        >
          {POST_PLATFORMS.map((platform) => (
            <option key={platform} value={platform}>
              {PLATFORM_LABELS[platform]}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Post URL"
        htmlFor="postUrl"
        hint="The full link to your published post."
        error={fieldErrors.postUrl?.[0]}
      >
        <Input
          id="postUrl"
          name="postUrl"
          type="url"
          inputMode="url"
          placeholder="https://tiktok.com/@yourhandle/video/..."
          required
          invalid={Boolean(fieldErrors.postUrl)}
        />
      </Field>

      <Field
        label="Caption / post text"
        htmlFor="caption"
        hint="Optional — the text you published with the post."
        error={fieldErrors.caption?.[0]}
      >
        <Textarea
          id="caption"
          name="caption"
          maxLength={500}
          placeholder="The caption that appears on the post."
        />
      </Field>

      <Field
        label="Creator note"
        htmlFor="creatorNote"
        hint="Optional, up to 1000 characters. Anything the advertiser should know."
        error={fieldErrors.creatorNote?.[0]}
      >
        <Textarea
          id="creatorNote"
          name="creatorNote"
          maxLength={1000}
          placeholder="e.g. the post went live at 6pm and I also shared it to my story."
        />
      </Field>

      <SubmitButton
        variant="accent"
        size="lg"
        className="w-full"
        pendingLabel="Submitting…"
      >
        Submit content
      </SubmitButton>

      <p className="text-xs leading-relaxed text-ink-faint">
        Your post will be submitted for verification. Views and engagement are
        not manually entered and will only count toward payment after Agenda
        verifies them.
      </p>
    </form>
  );
}
