-- DEV-103: ledger source for native non-stock AP invoices. Kept in its own
-- migration because a new enum value cannot be used in the transaction that
-- adds it.
BEGIN;

ALTER TYPE "FinanceSourceKind" ADD VALUE IF NOT EXISTS 'PHARMACY_AP_INVOICE';

COMMIT;
