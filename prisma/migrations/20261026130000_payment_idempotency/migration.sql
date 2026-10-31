-- Expand only: historical rows do not represent idempotent commands and therefore
-- intentionally retain NULLs. New application writes always supply both values.
-- Adding nullable columns is metadata-only, avoiding a table rewrite and prolonged
-- ACCESS EXCLUSIVE lock on a populated payments table.
ALTER TABLE "payments" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "payments" ADD COLUMN "requestFingerprint" TEXT;

-- Matches `@@unique([organizationId, idempotencyKey])` in schema.prisma exactly so
-- migrate diff stays clean. A plain unique index already treats NULLs as distinct,
-- so historical rows with NULL keys never conflict. CONCURRENTLY keeps payment
-- writes available while the index scans a non-empty production table. This
-- migration must remain non-transactional (Prisma runs PostgreSQL migration files
-- without an implicit transaction).
CREATE UNIQUE INDEX CONCURRENTLY "payments_organizationId_idempotencyKey_key"
  ON "payments"("organizationId", "idempotencyKey");
