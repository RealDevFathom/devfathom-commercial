-- The same person may belong to independent customer organizations. Identity
-- uniqueness is therefore tenant-local, matching host-scoped authentication.
DROP INDEX IF EXISTS "users_email_key";
CREATE UNIQUE INDEX "users_organizationId_email_key"
    ON "users"("organizationId", "email");
