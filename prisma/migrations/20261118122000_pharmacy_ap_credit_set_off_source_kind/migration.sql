-- DEV-694: ledger source for a manager-approved supplier credit-note set-off
-- against a native AP invoice. Kept in its own migration because a new enum
-- value cannot be used in the transaction that adds it.
BEGIN;

ALTER TYPE "FinanceSourceKind" ADD VALUE IF NOT EXISTS 'PHARMACY_AP_CREDIT_SET_OFF';

COMMIT;
