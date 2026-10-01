import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";

import { getSessionUser } from "@/lib/authz";
import {
  PROFILE_PHOTO_ALLOWED_CONTENT_TYPES,
  PROFILE_PHOTO_MAX_BYTES,
} from "@/lib/profile-photo";

/**
 * Authenticated Vercel Blob upload endpoint for creator profile photos.
 *
 * This route does NOT receive the image bytes: it only issues a scoped client
 * token so the browser uploads directly to Blob storage. That keeps uploads
 * off the serverless request body (no 4.5 MB limit, no memory pressure, no
 * filesystem writes).
 *
 * Server-authoritative rules enforced here:
 *   - only an authenticated CREATOR gets a token (fail-closed otherwise);
 *   - only JPEG/PNG/WebP is accepted;
 *   - uploads are capped at 4 MB;
 *   - a random suffix is always added so pathnames can never be guessed or
 *     overwritten.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "Image storage is not configured on this server." },
      { status: 500 },
    );
  }

  let body: HandleUploadBody;

  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => {
        const user = await getSessionUser();

        if (!user || user.role !== "CREATOR") {
          throw new Error("You must be signed in as a creator to upload a photo.");
        }

        return {
          allowedContentTypes: [...PROFILE_PHOTO_ALLOWED_CONTENT_TYPES],
          maximumSizeInBytes: PROFILE_PHOTO_MAX_BYTES,
          addRandomSuffix: true,
        };
      },
      // The database write happens through the profile form's existing save
      // path once the browser holds the returned URL. Nothing to do here.
      onUploadCompleted: async () => {},
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload rejected." },
      { status: 400 },
    );
  }
}
