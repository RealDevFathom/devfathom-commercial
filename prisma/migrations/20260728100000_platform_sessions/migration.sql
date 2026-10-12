-- Platform console sessions are opaque, revocable, and stored only as hashes.
CREATE TABLE "platform_sessions" (
    "id" TEXT NOT NULL,
    "platformUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_sessions_tokenHash_key" ON "platform_sessions"("tokenHash");
CREATE INDEX "platform_sessions_platformUserId_expiresAt_idx"
    ON "platform_sessions"("platformUserId", "expiresAt");
CREATE INDEX "platform_sessions_expiresAt_revokedAt_idx"
    ON "platform_sessions"("expiresAt", "revokedAt");

ALTER TABLE "platform_sessions"
    ADD CONSTRAINT "platform_sessions_platformUserId_fkey"
    FOREIGN KEY ("platformUserId") REFERENCES "platform_users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Support access uses the same opaque-token pattern. The deterministic
-- backfill keeps a rolling migration safe; active sessions should be ended by
-- operations before deployment because their old cookie format is invalid.
ALTER TABLE "platform_support_sessions" ADD COLUMN "tokenHash" TEXT;
UPDATE "platform_support_sessions" SET "tokenHash" = "id" WHERE "tokenHash" IS NULL;
ALTER TABLE "platform_support_sessions" ALTER COLUMN "tokenHash" SET NOT NULL;
CREATE UNIQUE INDEX "platform_support_sessions_tokenHash_key"
    ON "platform_support_sessions"("tokenHash");

ALTER TABLE "platform_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_sessions_platform_only"
    ON "platform_sessions"
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
