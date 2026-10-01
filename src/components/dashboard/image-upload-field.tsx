"use client";

import { useState } from "react";
import { upload } from "@vercel/blob/client";

import { Avatar } from "@/components/dashboard/avatar";
import { buttonClasses, Button } from "@/components/ui/button";
import {
  isAllowedProfilePhotoContentType,
  isWithinProfilePhotoSize,
  PROFILE_PHOTO_MAX_BYTES,
} from "@/lib/profile-photo";
import { cn } from "@/lib/utils";

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

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    // Allow re-selecting the same file after a failure.
    event.target.value = "";

    if (!file) {
      return;
    }

    setUploadError(null);

    if (!isAllowedProfilePhotoContentType(file.type)) {
      const isIphoneFormat =
        file.type === "image/heic" || file.type === "image/heif";

      setUploadError(
        isIphoneFormat
          ? "This photo is in your phone's default HEIC format. In iOS Settings > Camera > Formats, choose \"Most Compatible\" and retake it, or share it to Files and upload the JPG copy."
          : "Choose a JPG, PNG or WebP image.",
      );
      return;
    }

    if (!isWithinProfilePhotoSize(file.size)) {
      setUploadError(
        `Image must be 4 MB or smaller (max ${PROFILE_PHOTO_MAX_BYTES / (1024 * 1024)} MB).`,
      );
      return;
    }

    setPending(true);

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

      setUrl(blob.url);
    } catch (uploadFailure) {
      // The failure is almost always the token route (auth, storage config,
      // rejected content type). Log it: on mobile there is no other way to
      // see what went wrong.
      console.error(`${label} upload failed`, uploadFailure);

      setUploadError(
        "Upload failed. Please check your connection and try again.",
      );
    } finally {
      setPending(false);
    }
  }

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
              onChange={handleFile}
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
