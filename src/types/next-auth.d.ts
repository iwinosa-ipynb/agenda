import type { DefaultSession } from "next-auth";

import type { UserRole } from "@/types";

/**
 * Extend the Auth.js types so `id` and `role` are available on the session and
 * on the JWT. The role is the single source of truth for UI/authorization
 * branching on the client.
 */
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: UserRole;
    } & DefaultSession["user"];
  }

  interface User {
    role: UserRole;
  }
}

// `next-auth/jwt` only re-exports the interface from `@auth/core/jwt`, so we
// augment the declaring module to make the extra claims type-safe.
declare module "@auth/core/jwt" {
  interface JWT {
    id: string;
    role: UserRole;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: UserRole;
  }
}
