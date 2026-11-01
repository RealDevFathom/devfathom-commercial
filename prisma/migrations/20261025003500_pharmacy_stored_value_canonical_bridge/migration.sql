-- Additive canonical mapping only; no historical balance, currency or source backfill.
ALTER TYPE "FinanceAccountCode" ADD VALUE IF NOT EXISTS 'CUSTOMER_WALLET_LIABILITY';
ALTER TYPE "FinanceSourceKind" ADD VALUE IF NOT EXISTS 'PHARMACY_STORED_VALUE_JOURNAL';

ALTER TABLE stored_value_journals
  ADD COLUMN currency "Currency",
  ADD COLUMN "originalJournalId" TEXT;
CREATE INDEX stored_value_journals_org_original_idx ON stored_value_journals("organizationId", "originalJournalId");
ALTER TABLE stored_value_journals ADD CONSTRAINT stored_value_journals_original_tenant_fk
  FOREIGN KEY ("organizationId", "originalJournalId") REFERENCES stored_value_journals("organizationId", id) ON DELETE RESTRICT ON UPDATE CASCADE;
