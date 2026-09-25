import { z } from "zod";

import { Platform } from "@/generated/prisma/client";
import {
  RATE_CARD_SERVICE_TYPES,
  type RateCardServiceType,
} from "@/lib/constants";

/**
 * Stage 12 — rate-card validation.
 *
 * Structural rules only (shape, bounds). Identity and ownership are resolved
 * from the session in the action layer; status transitions are enforced by the
 * service against the database, never from client input.
 */

const platformValues = Object.values(Platform) as [Platform, ...Platform[]];
const serviceTypeValues = [...RATE_CARD_SERVICE_TYPES] as [
  RateCardServiceType,
  ...RateCardServiceType[],
];

/** Same numeric guardrails as campaign quotes — one money vocabulary. */
const priceSchema = z
  .string({ message: "Enter a price." })
  .trim()
  .min(1, { message: "Enter a price." })
  .max(20, { message: "That amount is too long." })
  .refine((value) => /^\d+(\.\d{1,2})?$/.test(value), {
    message: "Enter a valid amount — digits only, at most two decimal places.",
  })
  .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0, {
    message: "Price must be greater than zero.",
  })
  .refine((value) => Number(value) <= 1_000_000_000, {
    message: "That amount is beyond the platform maximum.",
  });

/** Optional free-text note: trims and treats an empty string as absent. */
const descriptionSchema = z
  .string()
  .trim()
  .max(500, { message: "Description must be 500 characters or fewer." })
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined));

const currencySchema = z
  .string({ message: "Missing currency." })
  .trim()
  .length(3, { message: "Invalid currency code." })
  .transform((value) => value.toUpperCase());

/**
 * Only content, price and platform are accepted from the client. The creator
 * identity and the ACTIVE status are always resolved server-side.
 */
export const createRateCardItemSchema = z.object({
  platform: z.enum(platformValues, { message: "Choose a platform." }),
  serviceType: z.enum(serviceTypeValues, { message: "Choose a content type." }),
  price: priceSchema,
  currency: currencySchema,
  description: descriptionSchema,
});

export type CreateRateCardItemInput = z.infer<typeof createRateCardItemSchema>;

/**
 * Editing changes price/description only. Platform and service type are the
 * item's identity — changing them is a new listing, not an edit.
 */
export const updateRateCardItemSchema = z.object({
  itemId: z.uuid({ message: "Invalid rate-card item." }),
  price: priceSchema,
  currency: currencySchema,
  description: descriptionSchema,
});

export type UpdateRateCardItemInput = z.infer<typeof updateRateCardItemSchema>;

/** Deactivate / reactivate — only the item id, ownership resolved server-side. */
export const toggleRateCardItemSchema = z.object({
  itemId: z.uuid({ message: "Invalid rate-card item." }),
});
