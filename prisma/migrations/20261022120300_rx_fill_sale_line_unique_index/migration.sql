-- This migration must run outside a transaction because PostgreSQL forbids
-- CREATE INDEX CONCURRENTLY inside a transaction block.
CREATE UNIQUE INDEX CONCURRENTLY "pharmacy_prescription_fills_organizationId_saleLineId_key"
  ON "pharmacy_prescription_fills"("organizationId", "saleLineId")
  WHERE "saleLineId" IS NOT NULL;
