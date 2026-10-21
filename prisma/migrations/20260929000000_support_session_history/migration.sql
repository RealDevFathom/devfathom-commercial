-- Preserve support history and its organization link. Purge must retain the
-- organization record while audited support sessions exist.
ALTER TABLE "platform_support_sessions"
  DROP CONSTRAINT "platform_support_sessions_organizationId_fkey";
ALTER TABLE "platform_support_sessions"
  ADD CONSTRAINT "platform_support_sessions_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
