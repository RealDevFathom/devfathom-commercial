-- One-use support launch tickets let the platform hand an audited support
-- session to any tenant host (shared, custom, dedicated, or localhost) without
-- relying on a cross-subdomain cookie.
ALTER TABLE "platform_support_sessions"
    ADD COLUMN "tokenCiphertext" TEXT,
    ADD COLUMN "launchTokenHash" TEXT,
    ADD COLUMN "launchUsedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "platform_support_sessions_launchTokenHash_key"
    ON "platform_support_sessions"("launchTokenHash");
