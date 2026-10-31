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
FOREIGN KEY ("organizationId", "actorTenantUserId")
REFERENCES "users"("organizationId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- Tenant actors are meaningful only in an organization. NOT VALID retains legacy
-- rows with missing organization context while enforcing this rule for new writes.
ALTER TABLE "platform_audit_logs"
ADD CONSTRAINT "platform_audit_logs_tenant_actor_requires_organization_check"
CHECK ("actorTenantUserId" IS NULL OR "organizationId" IS NOT NULL) NOT VALID;
