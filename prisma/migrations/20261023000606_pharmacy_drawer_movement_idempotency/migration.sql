ALTER TABLE "pharmacy_drawer_movements"
  ADD COLUMN "operationKey" TEXT;

-- This migration must remain non-transactional: PostgreSQL prohibits CONCURRENTLY
-- in a transaction, and the ledger must remain writable while the index is built.
CREATE UNIQUE INDEX CONCURRENTLY "pharmacy_drawer_movements_org_operation_key"
  ON "pharmacy_drawer_movements"("organizationId", "operationKey");
