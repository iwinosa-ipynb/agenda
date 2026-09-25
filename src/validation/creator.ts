import { z } from "zod";

import { Category } from "@/generated/prisma/client";
import { CONNECTABLE_PLATFORMS } from "@/lib/constants";

// Re-exported from the client-safe constants module so UI code does not have to
// import this server-oriented file.
export { CONNECTABLE_PLATFORMS };
export type { ConnectablePlatform } from "@/lib/constants";

const categoryValues = Object.values(Category) as [Category, ...Category[]];

/** Optional free-text field: trims and treats an empty string as absent. */
function optionalText(max: number, message: string) {
  return z
    .string()
    .trim()
    .max(max, { message })
    .transform((value) => (value === "" ? undefined : value))
    .optional();
}

export const creatorProfileSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(2, { message: "Enter your display name." })
    .max(80, { message: "Display name is too long." }),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, { message: "Username must be at least 3 characters." })
    .max(30, { message: "Username must be at most 30 characters." })
    .regex(/^[a-z0-9_.]+$/, {
      message: "Use letters, numbers, underscore or dot only.",
    }),
  bio: optionalText(280, "Bio must be 280 characters or fewer."),
  location: optionalText(100, "Location is too long."),
  state: optionalText(100, "State is too long."),
  country: optionalText(100, "Country is too long."),
  category: z
    .union([z.enum(categoryValues), z.literal("")])
    .transform((value) => (value === "" ? undefined : value))
    .optional(),
  // Self-reported only. Never used for eligibility or payouts.
  followerCount: z.coerce
    .number({ message: "Enter a number." })
    .int({ message: "Follower count must be a whole number." })
    .min(0, { message: "Follower count cannot be negative." })
    .max(1_000_000_000, { message: "Follower count is too large." }),
  profileImage: z
    .union([
      z.url({ message: "Enter a valid image URL." }).max(500),
      z.literal(""),
    ])
    .transform((value) => (value === "" ? undefined : value))
    .optional(),
});

export type CreatorProfileInput = z.infer<typeof creatorProfileSchema>;

export const socialAccountSchema = z.object({
  platform: z.enum(CONNECTABLE_PLATFORMS, {
    message: "Choose a supported platform.",
  }),
  username: z
    .string()
    .trim()
    .transform((value) => value.replace(/^@+/, "").toLowerCase())
    .pipe(
      z
        .string()
        .min(1, { message: "Enter your username on that platform." })
        .max(50, { message: "Username is too long." })
        .regex(/^[a-z0-9_.-]+$/, {
          message: "Use letters, numbers, dot, underscore or hyphen only.",
        }),
    ),
  profileUrl: z
    .url({ message: "Enter a valid profile URL." })
    .trim()
    .max(300, { message: "URL is too long." }),
});

export type SocialAccountInput = z.infer<typeof socialAccountSchema>;
