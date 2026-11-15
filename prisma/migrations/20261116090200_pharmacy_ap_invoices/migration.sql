-- DEV-103: native non-stock supplier operating-expense invoices and their
-- invoice-directed settlements.
BEGIN;

DO $$ BEGIN
  CREATE TYPE "PharmacyApInvoiceStatus" AS ENUM ('POSTED', 'REVERSED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PharmacyApSettlementStatus" AS ENUM ('ACTIVE', 'REVERSED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "pharmacy_ap_invoices" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "payeeName" TEXT NOT NULL,
  "payeeKey" TEXT NOT NULL,
  "supplierInvoiceRef" TEXT NOT NULL,
  "invoiceDate" TIMESTAMP(3) NOT NULL,
  "dueDate" TIMESTAMP(3) NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "currency" "Currency" NOT NULL DEFAULT 'PKR',
  "description" TEXT NOT NULL,
  "evidenceReference" TEXT NOT NULL,
  "status" "PharmacyApInvoiceStatus" NOT NULL DEFAULT 'POSTED',
  "createKey" TEXT NOT NULL,
  "createPayloadHash" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "journalEntryId" TEXT NOT NULL,
  "reversedAt" TIMESTAMP(3),
  "reversedByUserId" TEXT,
  "reversalReason" TEXT,
  "reverseCommandKey" TEXT,
  "reversePayloadHash" TEXT,
  "reversalEntryId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_ap_invoices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_ap_invoices_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pharmacy_ap_invoices_entry_fkey" FOREIGN KEY ("organizationId", "journalEntryId") REFERENCES "finance_journal_entries"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pharmacy_ap_invoices_reversal_fkey" FOREIGN KEY ("organizationId", "reversalEntryId") REFERENCES "finance_journal_entries"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pharmacy_ap_invoices_amount_check" CHECK ("amountMinor" > 0),
  CONSTRAINT "pharmacy_ap_invoices_dates_check" CHECK ("dueDate" >= "invoiceDate"),
  CONSTRAINT "pharmacy_ap_invoices_text_check" CHECK (
    length(btrim("reference")) BETWEEN 1 AND 80
    AND length(btrim("payeeName")) BETWEEN 1 AND 160
    AND length("payeeKey") BETWEEN 1 AND 160
    AND length(btrim("supplierInvoiceRef")) BETWEEN 1 AND 80
    AND length(btrim("description")) BETWEEN 1 AND 500
    AND length(btrim("evidenceReference")) BETWEEN 1 AND 160
  ),
  CONSTRAINT "pharmacy_ap_invoices_state_check" CHECK (
    ("status" = 'POSTED' AND "reversalEntryId" IS NULL AND "reversedAt" IS NULL)
    OR ("status" = 'REVERSED' AND "reversalEntryId" IS NOT NULL AND "reversedAt" IS NOT NULL
        AND "reversalReason" IS NOT NULL AND "reverseCommandKey" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_ap_invoices_org_id_key" ON "pharmacy_ap_invoices"("organizationId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_ap_invoices_org_branch_id_key" ON "pharmacy_ap_invoices"("organizationId", "branchId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_ap_invoices_org_reference_key" ON "pharmacy_ap_invoices"("organizationId", "reference");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_ap_invoices_org_create_key" ON "pharmacy_ap_invoices"("organizationId", "createKey");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_ap_invoices_org_reverse_command_key" ON "pharmacy_ap_invoices"("organizationId", "reverseCommandKey");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_ap_invoices_org_entry_key" ON "pharmacy_ap_invoices"("organizationId", "journalEntryId");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_ap_invoices_org_reversal_entry_key" ON "pharmacy_ap_invoices"("organizationId", "reversalEntryId");
CREATE INDEX IF NOT EXISTS "pharmacy_ap_invoices_org_branch_status_due_idx" ON "pharmacy_ap_invoices"("organizationId", "branchId", "status", "dueDate");
-- Durable invoice identity: one live (non-reversed) invoice per payee and
-- supplier invoice reference across the organization.
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_ap_invoices_org_identity_live_key"
  ON "pharmacy_ap_invoices"("organizationId", "payeeKey", "supplierInvoiceRef")
  WHERE "status" = 'POSTED';

CREATE TABLE IF NOT EXISTS "pharmacy_ap_invoice_settlements" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "transactionId" TEXT NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "paidAt" TIMESTAMP(3) NOT NULL,
  "fundingAccount" TEXT NOT NULL,
  "status" "PharmacyApSettlementStatus" NOT NULL DEFAULT 'ACTIVE',
  "commandKey" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "reversedAt" TIMESTAMP(3),
  "reversedByUserId" TEXT,
  "reversalReason" TEXT,
  "reverseCommandKey" TEXT,
  "reversePayloadHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_ap_invoice_settlements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_ap_invoice_settlements_invoice_fkey" FOREIGN KEY ("organizationId", "branchId", "invoiceId") REFERENCES "pharmacy_ap_invoices"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pharmacy_ap_invoice_settlements_transaction_fkey" FOREIGN KEY ("organizationId", "transactionId") REFERENCES "pharmacy_bookkeeping_transactions"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pharmacy_ap_invoice_settlements_amount_check" CHECK ("amountMinor" > 0),
  CONSTRAINT "pharmacy_ap_invoice_settlements_funding_check" CHECK ("fundingAccount" IN ('CASH', 'BANK')),
  CONSTRAINT "pharmacy_ap_invoice_settlements_state_check" CHECK (
    ("status" = 'ACTIVE' AND "reversedAt" IS NULL AND "reverseCommandKey" IS NULL)
    OR ("status" = 'REVERSED' AND "reversedAt" IS NOT NULL AND "reversalReason" IS NOT NULL
        AND "reverseCommandKey" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_ap_settlements_org_id_key" ON "pharmacy_ap_invoice_settlements"("organizationId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_ap_settlements_org_transaction_key" ON "pharmacy_ap_invoice_settlements"("organizationId", "transactionId");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_ap_settlements_org_command_key" ON "pharmacy_ap_invoice_settlements"("organizationId", "commandKey");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_ap_settlements_org_reverse_command_key" ON "pharmacy_ap_invoice_settlements"("organizationId", "reverseCommandKey");
CREATE INDEX IF NOT EXISTS "pharmacy_ap_settlements_org_branch_invoice_idx" ON "pharmacy_ap_invoice_settlements"("organizationId", "branchId", "invoiceId", "status");

-- Invoices are never deleted; only the forward POSTED -> REVERSED transition
-- may change a row, and it may not touch the invoice's financial identity.
CREATE OR REPLACE FUNCTION guard_pharmacy_ap_invoice()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pharmacy AP invoices cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'REVERSED' THEN
    RAISE EXCEPTION 'pharmacy AP invoice % is final', OLD."id" USING ERRCODE = '55000';
  END IF;
  IF NEW."status" <> 'REVERSED'
     OR OLD."organizationId" IS DISTINCT FROM NEW."organizationId"
     OR OLD."branchId" IS DISTINCT FROM NEW."branchId"
     OR OLD."reference" IS DISTINCT FROM NEW."reference"
     OR OLD."payeeName" IS DISTINCT FROM NEW."payeeName"
     OR OLD."payeeKey" IS DISTINCT FROM NEW."payeeKey"
     OR OLD."supplierInvoiceRef" IS DISTINCT FROM NEW."supplierInvoiceRef"
     OR OLD."invoiceDate" IS DISTINCT FROM NEW."invoiceDate"
     OR OLD."dueDate" IS DISTINCT FROM NEW."dueDate"
     OR OLD."amountMinor" IS DISTINCT FROM NEW."amountMinor"
     OR OLD."currency" IS DISTINCT FROM NEW."currency"
     OR OLD."description" IS DISTINCT FROM NEW."description"
     OR OLD."evidenceReference" IS DISTINCT FROM NEW."evidenceReference"
     OR OLD."createKey" IS DISTINCT FROM NEW."createKey"
     OR OLD."createPayloadHash" IS DISTINCT FROM NEW."createPayloadHash"
     OR OLD."createdByUserId" IS DISTINCT FROM NEW."createdByUserId"
     OR OLD."journalEntryId" IS DISTINCT FROM NEW."journalEntryId" THEN
    RAISE EXCEPTION 'posted pharmacy AP invoice % is immutable', OLD."id" USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pharmacy_ap_invoices_guard ON "pharmacy_ap_invoices";
CREATE TRIGGER pharmacy_ap_invoices_guard
BEFORE UPDATE OR DELETE ON "pharmacy_ap_invoices"
FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_ap_invoice();

-- Settlements are never deleted; only ACTIVE -> REVERSED may change a row.
CREATE OR REPLACE FUNCTION guard_pharmacy_ap_invoice_settlement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pharmacy AP settlements cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'REVERSED' THEN
    RAISE EXCEPTION 'pharmacy AP settlement % is final', OLD."id" USING ERRCODE = '55000';
  END IF;
  IF NEW."status" <> 'REVERSED'
     OR OLD."organizationId" IS DISTINCT FROM NEW."organizationId"
     OR OLD."branchId" IS DISTINCT FROM NEW."branchId"
     OR OLD."invoiceId" IS DISTINCT FROM NEW."invoiceId"
     OR OLD."transactionId" IS DISTINCT FROM NEW."transactionId"
     OR OLD."amountMinor" IS DISTINCT FROM NEW."amountMinor"
     OR OLD."paidAt" IS DISTINCT FROM NEW."paidAt"
     OR OLD."fundingAccount" IS DISTINCT FROM NEW."fundingAccount"
     OR OLD."commandKey" IS DISTINCT FROM NEW."commandKey"
     OR OLD."payloadHash" IS DISTINCT FROM NEW."payloadHash"
     OR OLD."createdByUserId" IS DISTINCT FROM NEW."createdByUserId" THEN
    RAISE EXCEPTION 'active pharmacy AP settlement % is immutable', OLD."id" USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pharmacy_ap_invoice_settlements_guard ON "pharmacy_ap_invoice_settlements";
CREATE TRIGGER pharmacy_ap_invoice_settlements_guard
BEFORE UPDATE OR DELETE ON "pharmacy_ap_invoice_settlements"
FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_ap_invoice_settlement();

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['pharmacy_ap_invoices', 'pharmacy_ap_invoice_settlements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_branch_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_branch_isolation ON %I USING (current_setting(''app.is_platform_admin'', true) = ''true'' OR ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''') AND (NULLIF(current_setting(''app.current_branch_id'', true), '''') IS NULL OR "branchId" = current_setting(''app.current_branch_id'', true)))) WITH CHECK (current_setting(''app.is_platform_admin'', true) = ''true'' OR ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''') AND (NULLIF(current_setting(''app.current_branch_id'', true), '''') IS NULL OR "branchId" = current_setting(''app.current_branch_id'', true))))',
      table_name
    );
  END LOOP;
END $$;

COMMIT;
