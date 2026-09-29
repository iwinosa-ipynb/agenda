-- Password-reset challenges (Forgot Password). Hash-only token storage;
-- single-use consumption via conditional UPDATE; at most ONE PENDING
-- challenge per user ((userId, status) unique index). Mirrors the Stage 10
-- email-verification migration.
CREATE TYPE "PasswordResetStatus" AS ENUM ('PENDING', 'CONSUMED', 'SUPERSEDED', 'EXPIRED');

-- Session invalidation for stateless JWT sessions: bumped on every
-- successful password reset; the Auth.js jwt callback rejects tokens
-- minted before the bump.
ALTER TABLE "User" ADD COLUMN     "sessionVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "PasswordResetStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");
CREATE UNIQUE INDEX "PasswordResetToken_userId_status_key" ON "PasswordResetToken"("userId", "status");

ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
