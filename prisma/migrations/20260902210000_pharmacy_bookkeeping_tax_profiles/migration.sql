-- PH-FIN FIN-02/04: shared-journal bookkeeper workflow and effective-dated tax profiles.
ALTER TYPE "FinanceSourceKind" ADD VALUE 'PHARMACY_BOOKKEEPING_TRANSACTION';
ALTER TYPE "FinanceAccountCode" ADD VALUE 'OPERATING_EXPENSE';

CREATE TYPE "PharmacyBookkeepingKind" AS ENUM ('SUPPLIER_PAYMENT','CUSTOMER_RECEIPT','EXPENSE','PETTY_CASH','BANK_DEPOSIT','SETTLEMENT','VOUCHER','CHEQUE');
CREATE TYPE "PharmacyBookkeepingStatus" AS ENUM ('PENDING','POSTED','REVERSED');
CREATE TYPE "PharmacyAllocationSourceKind" AS ENUM ('PURCHASE_INVOICE','SUPPLIER_CREDIT','CUSTOMER_KHATA','EXPENSE');
CREATE TYPE "PharmacyChequeStatus" AS ENUM ('NONE','PDC','CLEARED','BOUNCED');
CREATE TYPE "PharmacyAccountingPeriodStatus" AS ENUM ('OPEN','CLOSED','REOPENED');
CREATE TYPE "PharmacyBankLineStatus" AS ENUM ('UNMATCHED','MATCHED','REVERSED');
CREATE TYPE "PharmacyTaxProductClass" AS ENUM ('MEDICINE','FRONT_SHOP');
CREATE TYPE "PharmacyTaxPriceMode" AS ENUM ('EXCLUSIVE','INCLUSIVE');
CREATE TYPE "PharmacyTaxProfileStatus" AS ENUM ('DRAFT','PUBLISHED','RETIRED');

CREATE TABLE "pharmacy_bookkeeping_transactions" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "reference" TEXT NOT NULL, "kind" "PharmacyBookkeepingKind" NOT NULL,
  "status" "PharmacyBookkeepingStatus" NOT NULL DEFAULT 'PENDING', "counterpartyName" TEXT,
  "amountMinor" INTEGER NOT NULL, "currency" "Currency" NOT NULL DEFAULT 'PKR', "occurredAt" TIMESTAMP(3) NOT NULL,
  "memo" TEXT, "chequeNumber" TEXT, "chequeDueAt" TIMESTAMP(3), "chequeStatus" "PharmacyChequeStatus" NOT NULL DEFAULT 'NONE',
  "bankReference" TEXT, "idempotencyKey" TEXT NOT NULL, "createdByUserId" TEXT NOT NULL,
  "postedAt" TIMESTAMP(3), "reversedAt" TIMESTAMP(3), "reversalReason" TEXT,
  "journalEntryId" TEXT, "reversalEntryId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_bookkeeping_transactions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_bookkeeping_amount_positive" CHECK ("amountMinor" > 0),
  CONSTRAINT "pharmacy_bookkeeping_cheque_fields" CHECK (
    ("kind" = 'CHEQUE' AND COALESCE(btrim("chequeNumber"),'') <> '') OR
    ("kind" <> 'CHEQUE' AND "chequeStatus" = 'NONE')
  )
);
CREATE UNIQUE INDEX "pharmacy_bookkeeping_transactions_org_id_key" ON "pharmacy_bookkeeping_transactions"("organizationId","id");
CREATE UNIQUE INDEX "pharmacy_bookkeeping_transactions_org_reference_key" ON "pharmacy_bookkeeping_transactions"("organizationId","reference");
CREATE UNIQUE INDEX "pharmacy_bookkeeping_transactions_org_idempotency_key" ON "pharmacy_bookkeeping_transactions"("organizationId","idempotencyKey");
CREATE INDEX "pharmacy_bookkeeping_transactions_org_branch_occurred_idx" ON "pharmacy_bookkeeping_transactions"("organizationId","branchId","occurredAt");
CREATE INDEX "pharmacy_bookkeeping_transactions_org_status_kind_idx" ON "pharmacy_bookkeeping_transactions"("organizationId","status","kind");

CREATE TABLE "pharmacy_bookkeeping_allocations" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "transactionId" TEXT NOT NULL, "sourceKind" "PharmacyAllocationSourceKind" NOT NULL,
  "sourceId" TEXT NOT NULL, "sourceReference" TEXT NOT NULL, "amountMinor" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_bookkeeping_allocations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_bookkeeping_allocation_positive" CHECK ("amountMinor" > 0)
);
CREATE UNIQUE INDEX "pharmacy_bookkeeping_allocations_org_id_key" ON "pharmacy_bookkeeping_allocations"("organizationId","id");
CREATE UNIQUE INDEX "pharmacy_bookkeeping_allocations_org_transaction_source_key" ON "pharmacy_bookkeeping_allocations"("organizationId","transactionId","sourceKind","sourceId");
CREATE INDEX "pharmacy_bookkeeping_allocations_org_source_idx" ON "pharmacy_bookkeeping_allocations"("organizationId","sourceKind","sourceId");
ALTER TABLE "pharmacy_bookkeeping_allocations" ADD CONSTRAINT "pharmacy_bookkeeping_allocations_transaction_fkey" FOREIGN KEY ("organizationId","transactionId") REFERENCES "pharmacy_bookkeeping_transactions"("organizationId","id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "pharmacy_accounting_periods" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "startsAt" TIMESTAMP(3) NOT NULL, "endsAt" TIMESTAMP(3) NOT NULL,
  "status" "PharmacyAccountingPeriodStatus" NOT NULL DEFAULT 'OPEN', "closedAt" TIMESTAMP(3),
  "closedByUserId" TEXT, "reopenedAt" TIMESTAMP(3), "reopenedByUserId" TEXT, "reopenReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_accounting_periods_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_accounting_period_range" CHECK ("startsAt" < "endsAt"),
  CONSTRAINT "pharmacy_accounting_period_close_evidence" CHECK (("status" = 'OPEN' AND "closedAt" IS NULL) OR ("status" <> 'OPEN' AND "closedAt" IS NOT NULL)),
  CONSTRAINT "pharmacy_accounting_period_reopen_evidence" CHECK ("status" <> 'REOPENED' OR ("reopenedAt" IS NOT NULL AND COALESCE(btrim("reopenReason"),'') <> ''))
);
CREATE UNIQUE INDEX "pharmacy_accounting_periods_org_id_key" ON "pharmacy_accounting_periods"("organizationId","id");
CREATE UNIQUE INDEX "pharmacy_accounting_periods_org_branch_range_key" ON "pharmacy_accounting_periods"("organizationId","branchId","startsAt","endsAt");
CREATE INDEX "pharmacy_accounting_periods_org_branch_status_idx" ON "pharmacy_accounting_periods"("organizationId","branchId","status");

CREATE TABLE "pharmacy_settlement_batches" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "reference" TEXT NOT NULL, "provider" TEXT NOT NULL,
  "tenderType" "PharmacyTenderType" NOT NULL, "businessDate" DATE NOT NULL, "expectedMinor" INTEGER NOT NULL,
  "settledMinor" INTEGER, "settledAt" TIMESTAMP(3), "bankReference" TEXT, "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_settlement_batches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_settlement_expected_nonnegative" CHECK ("expectedMinor" >= 0),
  CONSTRAINT "pharmacy_settlement_actual_nonnegative" CHECK ("settledMinor" IS NULL OR "settledMinor" >= 0)
);
CREATE UNIQUE INDEX "pharmacy_settlement_batches_org_id_key" ON "pharmacy_settlement_batches"("organizationId","id");
CREATE UNIQUE INDEX "pharmacy_settlement_batches_org_reference_key" ON "pharmacy_settlement_batches"("organizationId","reference");
CREATE INDEX "pharmacy_settlement_batches_org_branch_date_idx" ON "pharmacy_settlement_batches"("organizationId","branchId","businessDate");

CREATE TABLE "pharmacy_settlement_tenders" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "settlementBatchId" TEXT NOT NULL, "tenderId" TEXT NOT NULL, "amountMinor" INTEGER NOT NULL,
  CONSTRAINT "pharmacy_settlement_tenders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_settlement_tender_amount_positive" CHECK ("amountMinor" > 0)
);
CREATE UNIQUE INDEX "pharmacy_settlement_tenders_org_id_key" ON "pharmacy_settlement_tenders"("organizationId","id");
CREATE UNIQUE INDEX "pharmacy_settlement_tenders_org_batch_tender_key" ON "pharmacy_settlement_tenders"("organizationId","settlementBatchId","tenderId");
CREATE UNIQUE INDEX "pharmacy_settlement_tenders_org_tender_key" ON "pharmacy_settlement_tenders"("organizationId","tenderId");
ALTER TABLE "pharmacy_settlement_tenders" ADD CONSTRAINT "pharmacy_settlement_tenders_batch_fkey" FOREIGN KEY ("organizationId","settlementBatchId") REFERENCES "pharmacy_settlement_batches"("organizationId","id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_settlement_tenders" ADD CONSTRAINT "pharmacy_settlement_tenders_tender_fkey" FOREIGN KEY ("organizationId","tenderId") REFERENCES "pharmacy_tenders"("organizationId","id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "pharmacy_bank_statement_lines" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "statementRef" TEXT NOT NULL, "lineReference" TEXT NOT NULL,
  "bookedAt" TIMESTAMP(3) NOT NULL, "amountMinor" INTEGER NOT NULL, "description" TEXT NOT NULL,
  "status" "PharmacyBankLineStatus" NOT NULL DEFAULT 'UNMATCHED', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_bank_statement_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_bank_statement_amount_nonzero" CHECK ("amountMinor" <> 0)
);
CREATE UNIQUE INDEX "pharmacy_bank_statement_lines_org_id_key" ON "pharmacy_bank_statement_lines"("organizationId","id");
CREATE UNIQUE INDEX "pharmacy_bank_statement_lines_org_statement_line_key" ON "pharmacy_bank_statement_lines"("organizationId","statementRef","lineReference");
CREATE INDEX "pharmacy_bank_statement_lines_org_branch_booked_idx" ON "pharmacy_bank_statement_lines"("organizationId","branchId","bookedAt");

CREATE TABLE "pharmacy_bank_reconciliations" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "statementLineId" TEXT NOT NULL, "transactionId" TEXT NOT NULL, "amountMinor" INTEGER NOT NULL,
  "matchedByUserId" TEXT NOT NULL, "matchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reversedAt" TIMESTAMP(3), "reversalReason" TEXT,
  CONSTRAINT "pharmacy_bank_reconciliations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_bank_reconciliation_positive" CHECK ("amountMinor" > 0),
  CONSTRAINT "pharmacy_bank_reconciliation_reversal_evidence" CHECK ("reversedAt" IS NULL OR COALESCE(btrim("reversalReason"),'') <> '')
);
CREATE UNIQUE INDEX "pharmacy_bank_reconciliations_org_id_key" ON "pharmacy_bank_reconciliations"("organizationId","id");
CREATE UNIQUE INDEX "pharmacy_bank_reconciliations_org_line_transaction_key" ON "pharmacy_bank_reconciliations"("organizationId","statementLineId","transactionId");
CREATE INDEX "pharmacy_bank_reconciliations_org_transaction_idx" ON "pharmacy_bank_reconciliations"("organizationId","transactionId");
ALTER TABLE "pharmacy_bank_reconciliations" ADD CONSTRAINT "pharmacy_bank_reconciliations_line_fkey" FOREIGN KEY ("organizationId","statementLineId") REFERENCES "pharmacy_bank_statement_lines"("organizationId","id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_bank_reconciliations" ADD CONSTRAINT "pharmacy_bank_reconciliations_transaction_fkey" FOREIGN KEY ("organizationId","transactionId") REFERENCES "pharmacy_bookkeeping_transactions"("organizationId","id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "pharmacy_tax_profile_versions" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "versionNumber" INTEGER NOT NULL, "name" TEXT NOT NULL,
  "status" "PharmacyTaxProfileStatus" NOT NULL DEFAULT 'DRAFT', "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo" TIMESTAMP(3), "approvalReference" TEXT, "approvedAt" TIMESTAMP(3), "approvedByUserId" TEXT,
  "idempotencyKey" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_tax_profile_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_tax_profile_range" CHECK ("effectiveTo" IS NULL OR "effectiveFrom" < "effectiveTo"),
  CONSTRAINT "pharmacy_tax_profile_approval" CHECK ("status" <> 'PUBLISHED' OR (COALESCE(btrim("approvalReference"),'') <> '' AND "approvedAt" IS NOT NULL AND "approvedByUserId" IS NOT NULL))
);
CREATE UNIQUE INDEX "pharmacy_tax_profile_versions_org_id_key" ON "pharmacy_tax_profile_versions"("organizationId","id");
CREATE UNIQUE INDEX "pharmacy_tax_profile_versions_org_idempotency_key" ON "pharmacy_tax_profile_versions"("organizationId","idempotencyKey");
CREATE UNIQUE INDEX "pharmacy_tax_profile_versions_org_branch_version_key" ON "pharmacy_tax_profile_versions"("organizationId","branchId","versionNumber");
CREATE INDEX "pharmacy_tax_profile_versions_org_branch_status_effective_idx" ON "pharmacy_tax_profile_versions"("organizationId","branchId","status","effectiveFrom");

CREATE TABLE "pharmacy_tax_rule_versions" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "profileVersionId" TEXT NOT NULL, "productClass" "PharmacyTaxProductClass" NOT NULL,
  "pctHsCode" TEXT NOT NULL, "sroReference" TEXT, "sroProvisional" BOOLEAN NOT NULL DEFAULT true,
  "exemptionCode" TEXT, "priceMode" "PharmacyTaxPriceMode" NOT NULL, "rate" DECIMAL(9,6) NOT NULL,
  "roundingScale" INTEGER NOT NULL DEFAULT 2, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_tax_rule_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_tax_rule_rate" CHECK ("rate" >= 0 AND "rate" <= 1),
  CONSTRAINT "pharmacy_tax_rule_rounding" CHECK ("roundingScale" BETWEEN 0 AND 4),
  CONSTRAINT "pharmacy_tax_rule_sro_provisional" CHECK ("sroReference" IS NULL OR "sroProvisional" = true)
);
CREATE UNIQUE INDEX "pharmacy_tax_rule_versions_org_id_key" ON "pharmacy_tax_rule_versions"("organizationId","id");
CREATE UNIQUE INDEX "pharmacy_tax_rule_versions_org_profile_class_hs_key" ON "pharmacy_tax_rule_versions"("organizationId","profileVersionId","productClass","pctHsCode");
CREATE INDEX "pharmacy_tax_rule_versions_org_profile_idx" ON "pharmacy_tax_rule_versions"("organizationId","profileVersionId");
ALTER TABLE "pharmacy_tax_rule_versions" ADD CONSTRAINT "pharmacy_tax_rule_versions_profile_fkey" FOREIGN KEY ("organizationId","profileVersionId") REFERENCES "pharmacy_tax_profile_versions"("organizationId","id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Period locks fail closed at the database boundary for every posting path.
CREATE OR REPLACE FUNCTION pharmacy_assert_bookkeeping_period_open() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'POSTED' AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM 'POSTED') AND EXISTS (
    SELECT 1 FROM "pharmacy_accounting_periods" p
     WHERE p."organizationId" = NEW."organizationId" AND p."branchId" = NEW."branchId"
       AND p."status" = 'CLOSED' AND NEW."occurredAt" >= p."startsAt" AND NEW."occurredAt" < p."endsAt"
  ) THEN RAISE EXCEPTION 'PHARMACY_ACCOUNTING_PERIOD_CLOSED' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_bookkeeping_period_open BEFORE INSERT OR UPDATE OF "status" ON "pharmacy_bookkeeping_transactions" FOR EACH ROW EXECUTE FUNCTION pharmacy_assert_bookkeeping_period_open();

-- Published tax history is immutable. New dates/rates are new versions.
CREATE OR REPLACE FUNCTION pharmacy_tax_published_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'PUBLISHED' THEN RAISE EXCEPTION 'PHARMACY_TAX_PROFILE_PUBLISHED_IMMUTABLE' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_tax_profile_published_immutable BEFORE UPDATE OR DELETE ON "pharmacy_tax_profile_versions" FOR EACH ROW EXECUTE FUNCTION pharmacy_tax_published_immutable();

CREATE OR REPLACE FUNCTION pharmacy_tax_rule_published_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "pharmacy_tax_profile_versions" p WHERE p."organizationId"=OLD."organizationId" AND p."id"=OLD."profileVersionId" AND p."status"='PUBLISHED') THEN
    RAISE EXCEPTION 'PHARMACY_TAX_RULE_PUBLISHED_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_tax_rule_published_immutable BEFORE UPDATE OR DELETE ON "pharmacy_tax_rule_versions" FOR EACH ROW EXECUTE FUNCTION pharmacy_tax_rule_published_immutable();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pharmacy_bookkeeping_transactions','pharmacy_bookkeeping_allocations','pharmacy_accounting_periods',
    'pharmacy_settlement_batches','pharmacy_settlement_tenders','pharmacy_bank_statement_lines',
    'pharmacy_bank_reconciliations','pharmacy_tax_profile_versions','pharmacy_tax_rule_versions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("organizationId" = current_setting(''app.current_organization_id'', true)) WITH CHECK ("organizationId" = current_setting(''app.current_organization_id'', true))', t);
  END LOOP;
END $$;
