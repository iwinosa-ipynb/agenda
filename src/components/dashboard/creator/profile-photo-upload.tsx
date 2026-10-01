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
 * Creator profile photo uploader (Vercel Blob client upload).
 *
 * The selected file is uploaded straight from the browser to Blob storage via
 * the authenticated `/api/upload/profile-photo` token route — it never passes
 * through a large Next.js server request. On success the resulting public URL
 * is written into a hidden `profileImage` field and persisted by the normal
 * profile save (the existing URL-validated storage path is unchanged). No URL
 * is ever written to the database by this component itself, so a failed upload
 * cannot store a bad value.
 */
export function ProfilePhotoUpload({
  name,
  initialUrl,
  error,
}: {
  name: string;
  initialUrl: string | null;
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
        `profile-photos/${crypto.randomUUID()}-${file.name}`,
        file,
        {
          access: "public",
          handleUploadUrl: "/api/upload/profile-photo",
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
      <span className="block text-sm font-medium text-ink">Profile photo</span>

      {/* The URL the profile form persists through the existing save path. */}
      <input type="hidden" name="profileImage" value={url} />

      <div className="flex flex-wrap items-center gap-4">
        <Avatar name={name} imageUrl={url || null} size={72} />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => inputRef.current?.click()}
          >
            {pending
              ? "Uploading…"
              : url
                ? "Replace photo"
                : "Upload photo"}
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
            accept={[
              "image/jpeg",
              "image/png",
              "image/webp",
            ].join(",")}
            className="hidden"
            onChange={handleFile}
          />
        </div>
      </div>

      <p className="text-xs text-ink-soft">
        JPG, PNG or WebP, up to 4 MB. Saving your profile keeps the new photo;
        removing it saves without a photo.
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
