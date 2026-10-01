"use client";

import { useRef, useState } from "react";
import { upload } from "@vercel/blob/client";

import { Avatar } from "@/components/dashboard/avatar";
import { Button } from "@/components/ui/button";
import {
  isAllowedProfilePhotoContentType,
  isWithinProfilePhotoSize,
  PROFILE_PHOTO_MAX_BYTES,
} from "@/lib/profile-photo";

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
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    // Allow re-selecting the same file after a failure.
    event.target.value = "";

    if (!file) {
      return;
    }

    setUploadError(null);

    if (!isAllowedProfilePhotoContentType(file.type)) {
      setUploadError("Choose a JPG, PNG or WebP image.");
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
    } catch {
      setUploadError("Upload failed. Please check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      <span className="block text-sm font-medium text-ink">{label}</span>

      {/* The URL the surrounding form persists through its existing save path. */}
      <input type="hidden" name={fieldName} value={url} />

      <div className="flex flex-wrap items-center gap-4">
        <Avatar name={entityName} imageUrl={url || null} size={72} />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => inputRef.current?.click()}
          >
            {pending ? "Uploading…" : url ? `Replace ${label.toLowerCase()}` : `Upload ${label.toLowerCase()}`}
          </Button>

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

          <input
            ref={inputRef}
            type="file"
            accept={["image/jpeg", "image/png", "image/webp"].join(",")}
            className="hidden"
            onChange={handleFile}
          />
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
