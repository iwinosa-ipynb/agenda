import "server-only";

import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";

import { getSessionUser } from "@/lib/authz";
import {
  isAllowedUploadPathname,
  PROFILE_PHOTO_ALLOWED_CONTENT_TYPES,
  PROFILE_PHOTO_MAX_BYTES,
} from "@/lib/profile-photo";
import type { UserRole } from "@/types";

/**
 * TEMPORARY diagnostic marker — remove after the iPhone test.
 *
 * `@vercel/blob`'s client `upload()` does not expose the token-response
 * headers to its caller, so the uploader issues a tiny follow-up probe to
 * this same route and reads this header back to prove the server was
 * reached. It carries no secrets — just the literal string "reached".
 */
const DIAG_HEADERS = { "x-diag-server": "reached" } as const;

/**
 * Shared server-side engine for ALL Vercel Blob client-upload routes.
 *
 * One storage system, one security model — flows differ ONLY in which role
 * may upload and which storage prefix their blobs live under:
 *
 *   - the caller must be authenticated with exactly the allowed role
 *     (fail-closed otherwise);
 *   - the requested blob pathname MUST belong to that flow's prefix (so a
 *     CREATOR can never mint a token for an advertiser-logo path, and no
 *     path traversal is possible);
 *   - only JPEG/PNG/WebP is accepted, capped at 4 MB;
 *   - a random suffix is always added so pathnames can never be guessed or
 *     overwritten;
 *   - the image bytes never pass through this server: this route only mints
 *     a scoped client token, so uploads stay off the serverless request body
 *     and no files touch the filesystem.
 */
export async function handleImageUploadRequest(
  request: Request,
  options: {
    /** The ONLY role that may mint a token on this route. */
    allowedRole: UserRole;
    /** Storage prefix (e.g. "profile-photos/") this flow owns. */
    pathnamePrefix: string;
  },
): Promise<NextResponse> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "Image storage is not configured on this server." },
      { status: 500, headers: DIAG_HEADERS },
    );
  }

  let body: HandleUploadBody;

  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid request." },
      { status: 400, headers: DIAG_HEADERS },
    );
  }

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        const user = await getSessionUser();

        if (!user || user.role !== options.allowedRole) {
          throw new Error(
            `You must be signed in as ${options.allowedRole.toLowerCase()} to upload this image.`,
          );
        }

        if (!isAllowedUploadPathname(pathname, options.pathnamePrefix)) {
          throw new Error("Invalid upload destination.");
        }

        return {
          allowedContentTypes: [...PROFILE_PHOTO_ALLOWED_CONTENT_TYPES],
          maximumSizeInBytes: PROFILE_PHOTO_MAX_BYTES,
          addRandomSuffix: true,
        };
      },
      // The database write happens through each flow's existing profile save
      // path once the browser holds the returned URL. Nothing to do here.
      onUploadCompleted: async () => {},
    });

    return NextResponse.json(jsonResponse, { headers: DIAG_HEADERS });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload rejected." },
      { status: 400, headers: DIAG_HEADERS },
    );
  }
}
