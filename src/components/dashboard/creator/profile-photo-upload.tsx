"use client";

import { ImageUploadField } from "@/components/dashboard/image-upload-field";
import { CREATOR_PHOTO_PREFIX } from "@/lib/profile-photo";

/**
 * Creator profile photo uploader — the shared ImageUploadField bound to the
 * creator flow's authenticated token route and hidden `profileImage` field.
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
  return (
    <ImageUploadField
      fieldName="profileImage"
      label="Profile photo"
      entityName={name}
      initialUrl={initialUrl}
      handleUploadUrl="/api/upload/profile-photo"
      uploadPrefix={CREATOR_PHOTO_PREFIX}
      error={error}
    />
  );
}
