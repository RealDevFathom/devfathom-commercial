-- CEO-JVCORE-20261025: additive ledger vocabulary for the pharmacy general
-- journal voucher. Kept in its own migration because a new enum value cannot be
-- used in the transaction that adds it.
BEGIN;

ALTER TYPE "FinanceSourceKind" ADD VALUE IF NOT EXISTS 'PHARMACY_JOURNAL_VOUCHER';
ALTER TYPE "FinanceAccountCode" ADD VALUE IF NOT EXISTS 'MANUAL_NONTRADE_ACCRUAL';

COMMIT;
