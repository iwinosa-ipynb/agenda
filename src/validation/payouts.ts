import { z } from "zod";

/**
 * Stage 14C — creator payout-recipient validation.
 *
 * SECURITY MODEL: a client may submit bank details ONCE, through an
 * authenticated creator session; the server validates them and calls the
 * provider port to create the recipient. A recipient CODE is never accepted
 * from a client — codes are created server-side and stored server-side. The
 * raw account number is validated and passed to the provider but never
 * persisted (the provider holds it; Agenda stores only the provider's code
 * and its verified account name).
 */

export const savePayoutRecipientSchema = z.object({
  /** 10-digit Nigerian NUBAN account number. */
  accountNumber: z
    .string()
    .trim()
    .regex(/^\d{10}$/, { message: "Provide a 10-digit bank account number." }),
  /** Paystack bank code (resolved from the server-side bank list). */
  bankCode: z
    .string()
    .trim()
    .min(1, { message: "Select a bank." })
    .max(20),
  /** The account-holder name as the creator's bank registered it. */
  accountName: z
    .string()
    .trim()
    .min(3, { message: "Provide the account holder's name." })
    .max(200),
  currency: z.string().trim().length(3).default("NGN"),
});

export type SavePayoutRecipientInput = z.infer<typeof savePayoutRecipientSchema>;
