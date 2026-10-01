import { handleImageUploadRequest } from "@/lib/blob-upload-server";
import { CREATOR_PHOTO_PREFIX } from "@/lib/profile-photo";

/** Creator-only upload endpoint for profile photos (see lib/blob-upload-server). */
export async function POST(request: Request) {
  return handleImageUploadRequest(request, {
    allowedRole: "CREATOR",
    pathnamePrefix: CREATOR_PHOTO_PREFIX,
  });
}
