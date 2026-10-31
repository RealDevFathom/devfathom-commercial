-- Audit actors are historical references, not account lifecycle dependencies.
-- SET NULL/CASCADE would UPDATE append-only rows and block account deletion,
-- including deletion by the tenant retention worker. Keep the IDs and indexes.
ALTER TABLE "platform_audit_logs"
DROP CONSTRAINT "platform_audit_logs_actorPlatformUserId_fkey",
DROP CONSTRAINT "platform_audit_logs_actorTenantUserId_fkey";
