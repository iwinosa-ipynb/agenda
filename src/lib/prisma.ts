import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";

// Prisma 7 requires an explicit driver adapter. The pool connects lazily on
// the first query, so importing this module never opens a connection and never
// requires DATABASE_URL to be present at build time.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and configure your database before querying.",
    );
  }

  const adapter = new PrismaPg({ connectionString });

  return new PrismaClient({ adapter });
}

function getPrismaClient(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createPrismaClient();
  }

  return globalForPrisma.prisma;
}

// A lazy proxy means `prisma` can be imported anywhere (including modules that
// are evaluated during `next build`) without a live database connection.
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const client = getPrismaClient();
    const value = Reflect.get(client, property, receiver);

    // Bind methods to the real client so `this` resolves correctly.
    return typeof value === "function" ? value.bind(client) : value;
  },
});
