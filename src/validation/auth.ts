import { z } from "zod";

export const roleSchema = z.enum(["CREATOR", "ADVERTISER"], {
  message: "Choose whether you are a creator or an advertiser.",
});

export const emailSchema = z
  .email({ message: "Enter a valid email address." })
  .trim()
  .toLowerCase();

export const passwordSchema = z
  .string()
  .min(8, { message: "Password must be at least 8 characters." })
  // bcrypt truncates beyond 72 bytes — cap it so the stored hash is honest.
  .max(72, { message: "Password must be at most 72 characters." });

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, { message: "Password is required." }),
});

export const registerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, { message: "Enter your name." })
    .max(80, { message: "Name is too long." }),
  email: emailSchema,
  password: passwordSchema,
  role: roleSchema,
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

/**
 * Password reset uses the SAME password policy as registration (no duplicate
 * policy lives here) plus a confirmation cross-check, so the user cannot
 * lock themselves out with a typo.
 */
export const resetPasswordSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string().min(1, { message: "Confirm your new password." }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
