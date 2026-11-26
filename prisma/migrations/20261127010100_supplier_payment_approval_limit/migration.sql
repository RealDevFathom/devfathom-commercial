BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS "supplierPaymentApprovalLimitMinor" integer CHECK ("supplierPaymentApprovalLimitMinor" >= 0);
COMMIT;
