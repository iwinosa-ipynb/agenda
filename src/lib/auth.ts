import { compare } from "bcryptjs";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { prisma } from "@/lib/prisma";
import { loginSchema } from "@/validation/auth";

/**
 * Auth.js (NextAuth v5) configuration.
 *
 * Credentials + JWT sessions are used for the initial foundation. Because the
 * session is a signed cookie there is no database round-trip on every request,
 * and no adapter is required. When OAuth / email providers are added, attach
 * `@auth/prisma-adapter` here and switch to the database session strategy.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/auth/login" },
  providers: [
    Credentials({
      name: "Email and password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(rawCredentials) {
        const parsed = loginSchema.safeParse(rawCredentials);

        if (!parsed.success) {
          return null;
        }

        const { email, password } = parsed.data;

        const user = await prisma.user.findUnique({ where: { email } });

        if (!user) {
          // Still run a comparison to keep response timing flat and avoid
          // leaking which emails are registered.
          await compare(password, "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva");
          return null;
        }

        const passwordMatches = await compare(password, user.passwordHash);

        if (!passwordMatches) {
          return null;
        }

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        // Fresh sign-in: anchor the token to the session version at login
        // time and stamp the identity claims as before.
        const stored = await prisma.user.findUnique({
          where: { id: user.id },
          select: { sessionVersion: true },
        });

        token.id = user.id as string;
        token.role = user.role;
        token.sessionVersion = stored?.sessionVersion ?? 0;

        return token;
      }

      // Every subsequent request: re-read the CURRENT session version. A
      // token minted before a password reset (which bumps sessionVersion)
      // carries an older value and is force-invalidated here — the user is
      // bounced to login on their other devices. The only DB cost is a
      // single indexed primary-key lookup per request; the id/role claims
      // and the JWT strategy itself are unchanged.
      if (token.id) {
        const stored = await prisma.user.findUnique({
          where: { id: token.id },
          select: { sessionVersion: true },
        });

        if (stored && token.sessionVersion !== stored.sessionVersion) {
          token.sessionVersion = stored.sessionVersion;

          return null; // force re-authentication
        }
      }

      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id;
        session.user.role = token.role;
      }
      return session;
    },
  },
});
