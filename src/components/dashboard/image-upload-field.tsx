"use client";

import { useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";

import { Avatar } from "@/components/dashboard/avatar";
import { buttonClasses, Button } from "@/components/ui/button";
import {
  isAllowedProfilePhotoContentType,
  isWithinProfilePhotoSize,
  PROFILE_PHOTO_MAX_BYTES,
} from "@/lib/profile-photo";
import { cn } from "@/lib/utils";

/* ──▶ DIAG: module-eval marker (proves the bundle actually executed) ◀─ */
console.log("[DIAG] image-upload-field module evaluated");
/* ──────────────────────────────────────────────────────────────────── */

/**
 * Shared image uploader for Vercel Blob client uploads — used by the creator
 * profile photo AND the advertiser logo, so both flows have the identical UX:
 * Upload / Replace / Remove, live preview, initials fallback.
 *
 * The selected file uploads straight from the browser to Blob storage via the
 * flow's authenticated token route — it never passes through a large Next.js
 * server request. On success the resulting public URL is written into a
 * hidden input named `fieldName` and persisted by the form's normal save. No
 * URL is ever written to the database by this component itself, so a failed
 * upload cannot store a bad value.
 *
 * The `accept` list includes HEIC/HEIF because phones (iPhones by default)
 * hand the picker those types; the picker-level acceptance exists purely so
 * users can COMPLETE the selection and see a specific message instead of a
 * silently dead control. Server-side validation still enforces the JPEG/PNG/
 * WebP allow-list (those files are rejected with explicit guidance).
 */
export function ImageUploadField({
  fieldName,
  label,
  entityName,
  initialUrl,
  handleUploadUrl,
  uploadPrefix,
  acceptHint = "JPG, PNG or WebP, up to 4 MB.",
  error,
}: {
  /** Hidden-input name the surrounding form persists (e.g. profileImage/logoUrl). */
  fieldName: string;
  label: string;
  /** Display name used for the initials fallback avatar. */
  entityName: string;
  initialUrl: string | null;
  /** Authenticated token route for this flow. */
  handleUploadUrl: string;
  /** Storage prefix this flow owns (client-side path prefix). */
  uploadPrefix: string;
  acceptHint?: string;
  error?: string;
}) {
  const [url, setUrl] = useState(initialUrl ?? "");
  const [pending, setPending] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  /* ──▶ DIAG BLOCK: identity + render tracking ◀─ */
  const diagId = useRef(
    `IMG-${Math.random().toString(36).slice(2, 8)}`,
  ).current;
  const diagRenders = useRef(0);
  diagRenders.current += 1;

  /** Tag a DOM node once so we can tell whether React replaced it. */
  const diagTag = (el: HTMLInputElement | null): string => {
    const tagged = el as unknown as { __diagId?: string } | null;
    if (tagged && !tagged.__diagId) {
      tagged.__diagId = `E${Math.random().toString(36).slice(2, 7)}`;
    }
    return tagged ? (tagged.__diagId ?? "?") : "null";
  };
  /* ──────────────────────────────────────────────────────────────── */

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    /* ──▶ DIAG B4: handleFile actually invoked ◀─ */
    console.log(
      `[DIAG] ${diagId} B4 handleFile CALLED target=${diagTag(
        event.target as HTMLInputElement,
      )}`,
    );
    /* ──────────────────────────────────────────────────────────── */

    const file = event.target.files?.[0];

    /* ──▶ DIAG B5: File object exists? name/type/size ── */
    console.log(
      `[DIAG] ${diagId} B5 files.length=${
        event.target.files?.length ?? 0
      } name=${file?.name ?? "(none)"} type=${file?.type ?? "(none)"} size=${
        file?.size ?? "n/a"
      }`,
    );
    /* ──────────────────────────────────────────────────────────── */

    // Allow re-selecting the same file after a failure.
    event.target.value = "";

    if (!file) {
      /* ──▶ DIAG: no File object — silent early return (looks like "nothing happened") ── */
      console.log(
        `[DIAG] ${diagId} !! B5 NO FILE — early return (no error shown to user)`,
      );
      /* ──────────────────────────────────────────────────────── */
      return;
    }

    setUploadError(null);

    /* ──▶ DIAG B6: client-side validation ── */
    const diagAllowed = isAllowedProfilePhotoContentType(file.type);
    const diagSized = isWithinProfilePhotoSize(file.size);
    console.log(
      `[DIAG] ${diagId} B6 validation allowed=${diagAllowed} sized=${diagSized} type="${file.type}" size=${file.size}`,
    );
    /* ──────────────────────────────────────────────────────────── */

    if (!isAllowedProfilePhotoContentType(file.type)) {
      const isIphoneFormat =
        file.type === "image/heic" || file.type === "image/heif";

      /* ──▶ DIAG: rejected by content type (an error message IS rendered) ── */
      console.log(
        `[DIAG] ${diagId} !! B6 REJECTED contentType (isIphoneFormat=${isIphoneFormat}) — error message set`,
      );
      /* ──────────────────────────────────────────────────────── */

      setUploadError(
        isIphoneFormat
          ? "This photo is in your phone's default HEIC format. In iOS Settings > Camera > Formats, choose \"Most Compatible\" and retake it, or share it to Files and upload the JPG copy."
          : "Choose a JPG, PNG or WebP image.",
      );
      return;
    }

    if (!isWithinProfilePhotoSize(file.size)) {
      /* ──▶ DIAG: rejected by size (an error message IS rendered) ── */
      console.log(
        `[DIAG] ${diagId} !! B6 REJECTED size — error message set`,
      );
      /* ──────────────────────────────────────────────────────── */

      setUploadError(
        `Image must be 4 MB or smaller (max ${PROFILE_PHOTO_MAX_BYTES / (1024 * 1024)} MB).`,
      );
      return;
    }

    /* ──▶ DIAG B7: pending state set (label should switch to "Uploading…") ── */
    console.log(`[DIAG] ${diagId} B7 setPending(true)`);
    /* ──────────────────────────────────────────────────────────── */
    setPending(true);

    /* ──▶ DIAG B8: upload request initiated ── */
    console.log(
      `[DIAG] ${diagId} B8 upload() START prefix=${uploadPrefix} handleUploadUrl=${handleUploadUrl}`,
    );
    /* ──────────────────────────────────────────────────────────── */

    try {
      const blob = await upload(
        `${uploadPrefix}${crypto.randomUUID()}-${file.name}`,
        file,
        {
          access: "public",
          handleUploadUrl,
          contentType: file.type,
        },
      );

      /* ──▶ DIAG B10: Blob upload succeeded ── */
      console.log(`[DIAG] ${diagId} B10 upload() SUCCESS url=${blob.url}`);
      /* ──────────────────────────────────────────────────────── */

      /* ──▶ DIAG B12: state update → Avatar preview ── */
      console.log(`[DIAG] ${diagId} B12 setUrl() → UI update`);
      /* ──────────────────────────────────────────────────────── */
      setUrl(blob.url);
    } catch (uploadFailure) {
      // The failure is almost always the token route (auth, storage config,
      // rejected content type). Log it: on mobile there is no other way to
      // see what went wrong.
      /* ──▶ DIAG: upload threw — covers B9 (server reached) vs network ── */
      console.error(
        `[DIAG] ${diagId} !! B8/B10 upload() THREW:`,
        uploadFailure,
      );
      /* ──────────────────────────────────────────────────────── */
      console.error(`${label} upload failed`, uploadFailure);

      setUploadError(
        "Upload failed. Please check your connection and try again.",
      );
    } finally {
      /* ──▶ DIAG B7: pending cleared ── */
      console.log(`[DIAG] ${diagId} B7 setPending(false)`);
      /* ──────────────────────────────────────────────────────── */
      setPending(false);
    }
  }

  /*
   * On iOS Safari React's synthetic onChange never fires for <input type="file">
   * because the native `change` event dispatched by the OS picker does not
   * bubble to the React root container (React 17+ delegates events on the root,
   * not on `document`).  This was previously tracked upstream as
   * https://github.com/facebook/react/issues/25308 ("event not bubbling to
   * root on iOS Safari").  The user would tap Upload → pick a photo → the
   * picker closes — and nothing else happens: no preview, no error.
   *
   * The fix: attach a NATIVE change listener directly on the <input> element
   * via addEventListener, which runs regardless of React's event delegation.
   * A ref always points at the latest handleFile closure so the listener can
   * be registered once at mount and cleaned up at unmount.
   */
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleFileRef = useRef(handleFile);
  // Update the ref on every render so the listener always calls the latest
  // closure (which has access to the latest setUrl / setPending etc.).
  handleFileRef.current = handleFile;

  /* ──▶ DIAG: logs AFTER every render so we can see whether the ref still
         points at the SAME input element the listener was attached to ◀─ */
  useEffect(() => {
    console.log(
      `[DIAG] ${diagId} render#${diagRenders.current} ref=${diagTag(
        fileInputRef.current,
      )} pending=${pending} url=${url ? "set" : "empty"}`,
    );
  });
  /* ──────────────────────────────────────────────────────────────── */

  useEffect(() => {
    const input = fileInputRef.current;

    /* ──▶ DIAG: effect mount — is the ref populated? ◀─ */
    console.log(
      `[DIAG] ${diagId} MOUNT ref=${diagTag(input)}${
        input ? "" : " !!NULL-NO-LISTENER"
      }`,
    );
    /* ──────────────────────────────────────────────────────── */
    if (!input) return;

    const onNativeClick = (event: Event) => {
      /* ──▶ DIAG B1: input actually activated by user ── */
      console.log(
        `[DIAG] ${diagId} B1 input CLICK el=${diagTag(
          event.target as HTMLInputElement,
        )}`,
      );
      /* ──────────────────────────────────────────────────── */
    };

    const onNativeChange = (event: Event) => {
      const target = event.target as HTMLInputElement;
      const files = target.files;
      /* ──▶ DIAG B2/B3: native change fired + listener ran ── */
      console.log(
        `[DIAG] ${diagId} B2/B3 NATIVE change FIRED el=${diagTag(
          target,
        )} files.length=${files?.length ?? "n/a"} type=${
          files?.[0]?.type ?? "(none)"
        } size=${files?.[0]?.size ?? "n/a"}`,
      );
      /* ──────────────────────────────────────────────────── */
      handleFileRef.current(event as unknown as React.ChangeEvent<HTMLInputElement>);
    };

    /* ──▶ DIAG: document-level capture listener — catches a change event
           even if it is dispatched on some OTHER element (or our listener
           was somehow removed). Fires BEFORE the target's own listeners. ◀─ */
    const onDocCapture = (event: Event) => {
      const t = event.target as HTMLElement | null;
      if (t && t.tagName === "INPUT" && (t as HTMLInputElement).type === "file") {
        console.log(
          `[DIAG] ${diagId} DOC-CAPTURE ${
            event.type
          } target-is-ours=${t === input} el=${diagTag(
            t as HTMLInputElement,
          )} ours=${diagTag(input)}`,
        );
      }
    };
    /* ──────────────────────────────────────────────────────────────── */

    input.addEventListener("click", onNativeClick);
    input.addEventListener("change", onNativeChange);
    document.addEventListener("change", onDocCapture, true);

    /* ──▶ DIAG: listener attached to WHICH element? ── */
    console.log(`[DIAG] ${diagId} LISTENER attached el=${diagTag(input)}`);
    /* ──────────────────────────────────────────────────────── */

    return () => {
      /* ──▶ DIAG: cleanup — listener removed (would kill a pending event) ── */
      console.log(`[DIAG] ${diagId} CLEANUP listener removed el=${diagTag(input)}`);
      /* ──────────────────────────────────────────────────────── */
      input.removeEventListener("click", onNativeClick);
      input.removeEventListener("change", onNativeChange);
      document.removeEventListener("change", onDocCapture, true);
    };
  }, []);

  return (
    <div className="space-y-3">
      <span className="block text-sm font-medium text-ink">{label}</span>

      {/* The URL the surrounding form persists through its existing save path. */}
      <input type="hidden" name={fieldName} value={url} />

      {/*
        The label opens the OS picker without any JavaScript, but everything
        AFTER selecting a photo (validation, Blob upload, hidden-field update)
        needs the app's JavaScript. On browsers below the supported baseline
        React never hydrates, so say so instead of failing silently.
      */}
      <noscript>
        <p className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">
          Enable JavaScript to upload images — the picker can open without it,
          but the upload itself cannot run.
        </p>
      </noscript>

      <div className="flex flex-wrap items-center gap-4">
        <Avatar name={entityName} imageUrl={url || null} size={72} />

        <div className="flex flex-wrap items-center gap-2">
          {/*
            Native label activation, not a programmatic input.click(): a visible
            <label> wrapping a rendered (sr-only, NOT display:none) file input
            is a real user gesture on the input itself, so the OS file picker
            opens identically on iOS Safari, Android Chrome and desktop —
            WebKit silently drops synthetic clicks on non-rendered file inputs,
            which made this control dead on phones. The input stays focusable,
            so keyboard users can still tab to it and press Enter.
          */}
          <label
            className={cn(
              buttonClasses({ variant: "outline", size: "sm" }),
              pending && "pointer-events-none opacity-55",
            )}
          >
            {pending ? "Uploading…" : url ? `Replace ${label.toLowerCase()}` : `Upload ${label.toLowerCase()}`}
            <input
              type="file"
              accept={[
                "image/jpeg",
                "image/png",
                "image/webp",
                "image/heic",
                "image/heif",
              ].join(",")}
              className="sr-only"
              disabled={pending}
              ref={fileInputRef}
            />
          </label>

          {url ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => {
                setUrl("");
                setUploadError(null);
              }}
            >
              Remove
            </Button>
          ) : null}
        </div>
      </div>

      <p className="text-xs text-ink-soft">
        {acceptHint} Saving your profile keeps the new image; removing it saves
        without one.
      </p>

      {uploadError ? (
        <p role="alert" className="text-xs text-warning">
          {uploadError}
        </p>
      ) : null}

      {error ? <p className="text-xs text-warning">{error}</p> : null}
    </div>
  );
}
