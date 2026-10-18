-- CreateTable for password resets
-- Stores bcrypt-hashed 6-digit codes (never raw codes).
CREATE TABLE "PasswordReset" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordReset_pkey" PRIMARY KEY ("id")
);

-- Indexes for lookup
CREATE INDEX "PasswordReset_email_idx" ON "PasswordReset"("email");
CREATE INDEX "PasswordReset_expiresAt_idx" ON "PasswordReset"("expiresAt");

-- Foreign key linking reset to user by email (so resets auto-clean if user deleted)
ALTER TABLE "PasswordReset" ADD CONSTRAINT "PasswordReset_email_fkey"
    FOREIGN KEY ("email") REFERENCES "User"("email") ON DELETE CASCADE ON UPDATE CASCADE;
