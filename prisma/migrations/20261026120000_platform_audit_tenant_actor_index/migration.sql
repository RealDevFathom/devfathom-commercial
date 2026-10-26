-- Actor lookups and chronological incident review should be indexed for both actor types.
CREATE INDEX "platform_audit_logs_actorTenantUserId_createdAt_idx"
ON "platform_audit_logs"("actorTenantUserId", "createdAt");
