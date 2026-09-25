import { z } from "zod";

import { Category, Platform } from "@/generated/prisma/client";

const platformValues = Object.values(Platform) as [Platform, ...Platform[]];
const categoryValues = Object.values(Category) as [Category, ...Category[]];

export const CAMPAIGN_SORTS = ["newest", "budget", "deadline"] as const;
export type CampaignSort = (typeof CAMPAIGN_SORTS)[number];

export const campaignFilterSchema = z.object({
  q: z.string().trim().max(80, { message: "Search term is too long." }).optional(),
  platform: z.enum(platformValues).optional(),
  category: z.enum(categoryValues).optional(),
  location: z
    .string()
    .trim()
    .max(100, { message: "Location is too long." })
    .optional(),
  minFollowers: z.coerce.number().int().min(0).max(1_000_000_000).optional(),
  // Stage 12: budget-range filter replaces the retired CPM-rate filter.
  minBudget: z.coerce.number().min(0).max(1_000_000_000_000).optional(),
  sort: z.enum(CAMPAIGN_SORTS).optional(),
});

export type CampaignFilters = z.infer<typeof campaignFilterSchema>;

/** Search params can be a string or string[]; keep the first non-empty value. */
function pickParam(
  raw: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = raw[key];
  const first = Array.isArray(value) ? value[0] : value;
  return first && first.trim().length > 0 ? first.trim() : undefined;
}

/**
 * Parse URL query parameters into validated filters. Invalid values are
 * dropped rather than throwing, so a malformed link never breaks the page.
 */
export function parseCampaignFilters(
  raw: Record<string, string | string[] | undefined>,
): CampaignFilters {
  const parsed = campaignFilterSchema.safeParse({
    q: pickParam(raw, "q"),
    platform: pickParam(raw, "platform"),
    category: pickParam(raw, "category"),
    location: pickParam(raw, "location"),
    minFollowers: pickParam(raw, "minFollowers"),
    minBudget: pickParam(raw, "minBudget"),
    sort: pickParam(raw, "sort"),
  });

  return parsed.success ? parsed.data : {};
}

/**
 * Numeric quote guardrails shared by the client and server. Bounds are in the
 * campaign currency; the server re-validates everything — these exist for UX.
 */
export const QUOTE_MIN = 0.01;
export const QUOTE_MAX = 1_000_000_000;

/**
 * Quote amount as typed into a form: a plain decimal string. Structural
 * validation only (shape, bounds, no NaN/negatives/absurd precision) — the
 * service layer adds campaign-specific rules (currency match, deadline, etc.).
 */
export const quoteAmountSchema = z
  .string({ message: "Enter your requested fee." })
  .trim()
  .min(1, { message: "Enter your requested fee." })
  .max(20, { message: "That amount is too long." })
  .refine(
    (value) => /^\d+(\.\d{1,2})?$/.test(value),
    {
      message:
        "Enter a valid amount — digits only, at most two decimal places.",
    },
  )
  .refine(
    (value) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) && numeric >= QUOTE_MIN;
    },
    { message: "Your fee must be greater than zero." },
  )
  .refine((value) => Number(value) <= QUOTE_MAX, {
    message: "That amount is beyond the platform maximum.",
  });

/**
 * Only the campaign id, quote and proposal are accepted from the client. The
 * creator identity and application status are always resolved server-side.
 */
export const applyToCampaignSchema = z.object({
  campaignId: z.uuid({ message: "Invalid campaign." }),
  // The creator's requested fee — creator-controlled, validated server-side.
  quoteAmount: quoteAmountSchema,
  currency: z
    .string({ message: "Missing currency." })
    .trim()
    .length(3, { message: "Invalid currency code." })
    .transform((value) => value.toUpperCase()),
  message: z
    .string()
    .trim()
    .max(500, { message: "Message must be 500 characters or fewer." })
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
});

export const withdrawApplicationSchema = z.object({
  applicationId: z.uuid({ message: "Invalid application." }),
});

/**
 * Advertiser review decision. Only the application id and the button pressed
 * are accepted from the client; ownership is resolved server-side.
 */
export const reviewApplicationSchema = z.object({
  applicationId: z.uuid({ message: "Invalid application." }),
  decision: z.enum(["ACCEPT", "REJECT"], {
    message: "Invalid decision.",
  }),
});
