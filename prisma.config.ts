import "dotenv/config";
import { defineConfig } from "prisma/config";

// Prisma 7 keeps connection details out of schema.prisma. The URL is read
// from the environment only; never hardcode credentials here.
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
});
