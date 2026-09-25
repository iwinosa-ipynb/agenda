import "server-only";

import { hash } from "bcryptjs";

import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { prisma } from "@/lib/prisma";
import type { ActionResult } from "@/types";
import type { RegisterInput } from "@/validation/auth";

const BCRYPT_ROUNDS = 12;

/** Build a URL-safe, most-likely-unique username from an email address. */
function buildUsername(email: string): string {
  const localPart = email.split("@")[0] ?? "creator";
  const slug = localPart
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 20);

  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 5);

  return `${slug || "creator"}_${suffix}`;
}

export async function findUserByEmail(email: string) {
  return prisma.user.findUnique({ where: { email } });
}

/**
 * Create a user and the matching role profile in a single transaction.
 * Passwords are hashed here; the plaintext value never leaves this function.
 */
export async function createUser(
  input: RegisterInput,
): Promise<ActionResult<{ userId: string }>> {
  const email = input.email.toLowerCase();

  const existing = await findUserByEmail(email);

  if (existing) {
    return {
      success: false,
      error: "An account with this email already exists.",
      fieldErrors: { email: ["An account with this email already exists."] },
    };
  }

  const passwordHash = await hash(input.password, BCRYPT_ROUNDS);

  try {
    const user = await prisma.user.create({
      data: {
        name: input.name,
        email,
        passwordHash,
        role: input.role,
        creatorProfile:
          input.role === "CREATOR"
            ? { create: { username: buildUsername(email) } }
            : undefined,
        advertiserProfile:
          input.role === "ADVERTISER"
            ? { create: { companyName: input.name } }
            : undefined,
      },
      select: { id: true },
    });

    return { success: true, data: { userId: user.id } };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return {
        success: false,
        error: "An account with this email already exists.",
        fieldErrors: { email: ["An account with this email already exists."] },
      };
    }

    console.error("createUser failed", error);
    return { success: false, error: "Could not create your account." };
  }
}
