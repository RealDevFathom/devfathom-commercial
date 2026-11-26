BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE pharmacy_bookkeeping_transactions
  ADD COLUMN IF NOT EXISTS "supplierDraftFunding" text CHECK ("supplierDraftFunding" IN ('CASH','BANK'));
COMMIT;
