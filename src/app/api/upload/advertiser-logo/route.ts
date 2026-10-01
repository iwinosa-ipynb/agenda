import { handleImageUploadRequest } from "@/lib/blob-upload-server";
import { ADVERTISER_LOGO_PREFIX } from "@/lib/profile-photo";

/** Advertiser-only upload endpoint for company logos (see lib/blob-upload-server). */
export async function POST(request: Request) {
  return handleImageUploadRequest(request, {
    allowedRole: "ADVERTISER",
    pathnamePrefix: ADVERTISER_LOGO_PREFIX,
  });
}
