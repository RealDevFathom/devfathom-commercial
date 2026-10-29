CREATE INDEX "platform_audit_logs_actorTenantUserId_createdAt_idx"
ON "platform_audit_logs"("actorTenantUserId", "createdAt");

ALTER TABLE "platform_audit_logs"
ADD CONSTRAINT "platform_audit_logs_actorPlatformUserId_fkey"
FOREIGN KEY ("actorPlatformUserId") REFERENCES "platform_users"("id")
ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

ALTER TABLE "platform_audit_logs"
ADD CONSTRAINT "platform_audit_logs_actorTenantUserId_fkey"
FOREIGN KEY ("actorTenantUserId") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
