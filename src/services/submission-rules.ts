/**
 * Pure submission-state decision logic for creator content submissions.
 *
 * Lifecycle enforced here (and re-checked by the service against the
 * database, never against client input):
 *
 *   SUBMITTED → VERIFYING → VERIFIED
 *   SUBMITTED → VERIFYING → REJECTED → (new submission) SUBMITTED → …
 *
 * A creator has at most ONE active submission per campaign. A REJECTED post
 * is the only state that unlocks a replacement submission; VERIFIED posts are
 * never editable and never reset by the creator.
 *
 * Kept free of "server-only", Prisma and Next.js so it can be unit tested in
 * isolation from the database.
 */

import type { PostStatus } from "@/generated/prisma/client";

/** Minimal shape of the creator's existing posts for one campaign. */
export type ExistingSubmission = {
  id: string;
  status: PostStatus;
};

export type SubmissionDecision =
  | { kind: "FIRST_SUBMISSION" }
  | {
      kind: "RESUBMISSION_ALLOWED";
      /** The rejected record the new submission replaces. History is preserved. */
      previousPostId: string;
    }
  | { kind: "BLOCKED"; reason: string };

/**
 * Decide whether a creator may submit content for a campaign, given their
 * existing posts for that campaign (already scoped to this creator by the
 * caller's query). The decision depends only on post statuses:
 *
 * - no posts            → first submission
 * - only REJECTED posts → resubmission allowed (fresh submission record)
 * - any active post     → blocked (SUBMITTED / VERIFYING / VERIFIED)
 */
export function decideSubmission(
  existingPosts: ExistingSubmission[],
): SubmissionDecision {
  const activePost = existingPosts.find((post) => post.status !== "REJECTED");

  if (activePost) {
    switch (activePost.status) {
      case "SUBMITTED":
        return {
          kind: "BLOCKED",
          reason:
            "You already have a submission awaiting verification for this campaign.",
        };
      case "VERIFYING":
        return {
          kind: "BLOCKED",
          reason:
            "Your submission for this campaign is currently being verified.",
        };
      case "VERIFIED":
        return {
          kind: "BLOCKED",
          reason:
            "Your submission for this campaign was already verified. Rejected posts are the only ones that can be replaced.",
        };
      default:
        return {
          kind: "BLOCKED",
          reason: "You already have an active submission for this campaign.",
        };
    }
  }

  const rejectedPost = existingPosts.find((post) => post.status === "REJECTED");

  if (!rejectedPost) {
    return { kind: "FIRST_SUBMISSION" };
  }

  return {
    kind: "RESUBMISSION_ALLOWED",
    previousPostId: rejectedPost.id,
  };
}
