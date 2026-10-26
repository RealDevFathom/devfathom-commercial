-- Actor lookups and chronological incident review should be indexed for both actor types.
CREATE INDEX "platform_audit_logs_actorTenantUserId_createdAt_idx"
ON "platform_audit_logs"("actorTenantUserId", "createdAt");

-- Preserve any historical orphan identifiers while enforcing actor integrity for all
-- new writes. Audit actors are intentionally restricted from hard deletion.
ALTER TABLE "platform_audit_logs"
ADD CONSTRAINT "platform_audit_logs_actorPlatformUserId_fkey"
FOREIGN KEY ("actorPlatformUserId") REFERENCES "platform_users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "platform_audit_logs"
ADD CONSTRAINT "platform_audit_logs_actorTenantUserId_fkey"
FOREIGN KEY ("actorTenantUserId") REFERENCES "users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
