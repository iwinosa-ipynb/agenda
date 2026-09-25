import { z } from "zod";

import { POST_PLATFORMS } from "@/lib/constants";

const postPlatformValues = [
  ...POST_PLATFORMS,
] as [
  (typeof POST_PLATFORMS)[number],
  ...(typeof POST_PLATFORMS)[number][],
];

/**
 * Hostnames each platform's posts live on. Deliberately short and relaxed:
 * the goal is to catch an obviously wrong link (a TikTok URL pasted into an X
 * submission), not to enumerate every regional or vanity subdomain.
 */
const PLATFORM_URL_HOSTS: Record<(typeof postPlatformValues)[number], string[]> =
  {
    TIKTOK: ["tiktok.com"],
    X: ["x.com", "twitter.com"],
  };

function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * A creator's submitted content for a campaign. Only the link and descriptive
 * text are collected — views, likes and verified views are never accepted from
 * the client; they are recorded exclusively by the future verification system.
 */
export const campaignPostSchema = z.object({
  platform: z.enum(postPlatformValues, {
    message: "Choose the platform you published on.",
  }),
  postUrl: z
    .url({ message: "Enter a valid post URL." })
    .trim()
    .max(500, { message: "URL is too long." })
    .refine((value) => /^https:\/\//i.test(value), {
      message: "Post URLs must start with https://",
    }),
  caption: z
    .string()
    .trim()
    .max(500, { message: "Caption must be 500 characters or fewer." })
    .transform((value) => (value === "" ? undefined : value))
    .optional(),
  creatorNote: z
    .string()
    .trim()
    .max(1000, { message: "Creator note must be 1000 characters or fewer." })
    .transform((value) => (value === "" ? undefined : value))
    .optional(),
});

export type CampaignPostInput = z.infer<typeof campaignPostSchema>;

/**
 * Refine the parsed post so the URL actually points at the selected platform.
 * Runs after the base schema so the URL is already normalised and valid.
 */
export function parseCampaignPost(
  raw: Record<string, FormDataEntryValue | null>,
): { success: true; data: CampaignPostInput } | { success: false; fieldErrors: Record<string, string[]> } {
  const parsed = campaignPostSchema.safeParse(raw);

  if (!parsed.success) {
    return {
      success: false,
      fieldErrors: flattenPostFieldErrors(parsed.error),
    };
  }

  const host = hostOf(parsed.data.postUrl);

  if (!host) {
    return { success: false, fieldErrors: { postUrl: ["Enter a valid post URL."] } };
  }

  const allowedHosts = PLATFORM_URL_HOSTS[parsed.data.platform];

  if (!allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
    return {
      success: false,
      fieldErrors: {
        postUrl: [
          `That link doesn't look like a ${parsed.data.platform === "X" ? "X (Twitter)" : "TikTok"} post URL.`,
        ],
      },
    };
  }

  return { success: true, data: parsed.data };
}

function flattenPostFieldErrors(error: z.ZodError): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "form";
    (result[key] ??= []).push(issue.message);
  }

  return result;
}
