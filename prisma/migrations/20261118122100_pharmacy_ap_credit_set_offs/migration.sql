-- DEV-694: supplier credit-note set-off against native AP invoices.
-- Staff choose the bill (PENDING). The payable reduces only when a manager
-- approves with a fresh PIN (APPROVED), which links the canonical ledger entry.
-- A rejected request changes no money. Rows are never deleted.
BEGIN;

DO $$ BEGIN
  CREATE TYPE "PharmacyApCreditSetOffStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "pharmacy_ap_credit_set_offs" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "supplierCreditId" TEXT NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "currency" "Currency" NOT NULL DEFAULT 'PKR',
  "status" "PharmacyApCreditSetOffStatus" NOT NULL DEFAULT 'PENDING',
  "note" TEXT,
  "requestKey" TEXT NOT NULL,
  "requestPayloadHash" TEXT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decisionKey" TEXT,
  "decidedByUserId" TEXT,
  "decidedAt" TIMESTAMP(3),
  "approvalPolicy" TEXT,
  "rejectionReason" TEXT,
  "journalEntryId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_ap_credit_set_offs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_ap_credit_set_offs_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pharmacy_ap_credit_set_offs_invoice_fkey" FOREIGN KEY ("organizationId", "branchId", "invoiceId") REFERENCES "pharmacy_ap_invoices"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pharmacy_ap_credit_set_offs_credit_fkey" FOREIGN KEY ("organizationId", "supplierCreditId") REFERENCES "pharmacy_supplier_credits"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pharmacy_ap_credit_set_offs_entry_fkey" FOREIGN KEY ("organizationId", "journalEntryId") REFERENCES "finance_journal_entries"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pharmacy_ap_credit_set_offs_amount_check" CHECK ("amountMinor" > 0),
  -- Supplier credits carry no currency of their own; they are PKR.
  CONSTRAINT "pharmacy_ap_credit_set_offs_currency_check" CHECK ("currency" = 'PKR'),
  CONSTRAINT "pharmacy_ap_credit_set_offs_text_check" CHECK (
    length("requestKey") BETWEEN 8 AND 160
    AND ("note" IS NULL OR length("note") <= 500)
    AND ("rejectionReason" IS NULL OR length(btrim("rejectionReason")) BETWEEN 1 AND 500)
  ),
  CONSTRAINT "pharmacy_ap_credit_set_offs_state_check" CHECK (
    ("status" = 'PENDING' AND "decidedAt" IS NULL AND "decidedByUserId" IS NULL
        AND "decisionKey" IS NULL AND "journalEntryId" IS NULL AND "rejectionReason" IS NULL)
    OR ("status" = 'APPROVED' AND "decidedAt" IS NOT NULL AND "decidedByUserId" IS NOT NULL
        AND "decisionKey" IS NOT NULL AND "journalEntryId" IS NOT NULL
        AND "approvalPolicy" IS NOT NULL AND "rejectionReason" IS NULL)
    OR ("status" = 'REJECTED' AND "decidedAt" IS NOT NULL AND "decidedByUserId" IS NOT NULL
        AND "decisionKey" IS NOT NULL AND "journalEntryId" IS NULL AND "rejectionReason" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_ap_credit_set_offs_org_id_key" ON "pharmacy_ap_credit_set_offs"("organizationId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_ap_credit_set_offs_org_request_key" ON "pharmacy_ap_credit_set_offs"("organizationId", "requestKey");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_ap_credit_set_offs_org_decision_key" ON "pharmacy_ap_credit_set_offs"("organizationId", "decisionKey");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_ap_credit_set_offs_org_entry_key" ON "pharmacy_ap_credit_set_offs"("organizationId", "journalEntryId");
CREATE INDEX IF NOT EXISTS "pharmacy_ap_credit_set_offs_org_branch_status_idx" ON "pharmacy_ap_credit_set_offs"("organizationId", "branchId", "status");
CREATE INDEX IF NOT EXISTS "pharmacy_ap_credit_set_offs_org_credit_status_idx" ON "pharmacy_ap_credit_set_offs"("organizationId", "supplierCreditId", "status");
CREATE INDEX IF NOT EXISTS "pharmacy_ap_credit_set_offs_org_invoice_status_idx" ON "pharmacy_ap_credit_set_offs"("organizationId", "branchId", "invoiceId", "status");

-- Never deleted; only the one-way PENDING -> APPROVED or PENDING -> REJECTED
-- decision may change a row, and it may not touch what was requested.
CREATE OR REPLACE FUNCTION guard_pharmacy_ap_credit_set_off()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pharmacy AP credit set-offs cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'pharmacy AP credit set-off % is final', OLD."id" USING ERRCODE = '55000';
  END IF;
  IF NEW."status" NOT IN ('APPROVED', 'REJECTED')
     OR OLD."organizationId" IS DISTINCT FROM NEW."organizationId"
     OR OLD."branchId" IS DISTINCT FROM NEW."branchId"
     OR OLD."invoiceId" IS DISTINCT FROM NEW."invoiceId"
     OR OLD."supplierCreditId" IS DISTINCT FROM NEW."supplierCreditId"
     OR OLD."amountMinor" IS DISTINCT FROM NEW."amountMinor"
     OR OLD."currency" IS DISTINCT FROM NEW."currency"
     OR OLD."note" IS DISTINCT FROM NEW."note"
     OR OLD."requestKey" IS DISTINCT FROM NEW."requestKey"
     OR OLD."requestPayloadHash" IS DISTINCT FROM NEW."requestPayloadHash"
     OR OLD."requestedByUserId" IS DISTINCT FROM NEW."requestedByUserId"
     OR OLD."requestedAt" IS DISTINCT FROM NEW."requestedAt" THEN
    RAISE EXCEPTION 'pharmacy AP credit set-off request % is immutable', OLD."id" USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pharmacy_ap_credit_set_offs_guard ON "pharmacy_ap_credit_set_offs";
CREATE TRIGGER pharmacy_ap_credit_set_offs_guard
BEFORE UPDATE OR DELETE ON "pharmacy_ap_credit_set_offs"
FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_ap_credit_set_off();

ALTER TABLE "pharmacy_ap_credit_set_offs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_ap_credit_set_offs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_branch_isolation ON "pharmacy_ap_credit_set_offs";
CREATE POLICY tenant_branch_isolation ON "pharmacy_ap_credit_set_offs"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
        AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
             OR "branchId" = current_setting('app.current_branch_id', true)))
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
        AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
             OR "branchId" = current_setting('app.current_branch_id', true)))
  );

COMMIT;
