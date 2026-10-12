ALTER TABLE "platform_users"
  ADD COLUMN "encryptedTotpSecret" TEXT,
  ADD COLUMN "mfaEnabledAt" TIMESTAMP(3);

ALTER TABLE "platform_users" ALTER COLUMN "mfaRequired" SET DEFAULT false;
UPDATE "platform_users"
SET "mfaRequired" = false
WHERE "mfaEnabledAt" IS NULL;

CREATE TABLE "platform_recovery_codes" (
  "id" TEXT NOT NULL,
  "platformUserId" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_recovery_codes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_recovery_codes_platformUserId_fkey"
    FOREIGN KEY ("platformUserId") REFERENCES "platform_users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "platform_recovery_codes_platformUserId_codeHash_key"
  ON "platform_recovery_codes"("platformUserId", "codeHash");
CREATE INDEX "platform_recovery_codes_platformUserId_usedAt_idx"
  ON "platform_recovery_codes"("platformUserId", "usedAt");

ALTER TABLE "platform_recovery_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_recovery_codes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_control_plane_only" ON "platform_recovery_codes"
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
