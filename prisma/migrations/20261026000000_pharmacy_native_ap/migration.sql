-- #691: durable non-stock supplier invoices linked to canonical journal settlements.
ALTER TYPE "FinanceSourceKind" ADD VALUE 'PHARMACY_SUPPLIER_EXPENSE_INVOICE';
CREATE TYPE "PharmacySupplierExpenseInvoiceStatus" AS ENUM ('OPEN', 'PAID', 'VOID');
CREATE TYPE "PharmacySupplierExpenseSettlementStatus" AS ENUM ('POSTED', 'REVERSED');

CREATE TABLE "pharmacy_supplier_expense_invoices" (
 "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
 "branchId" TEXT NOT NULL, "supplierId" TEXT NOT NULL, "supplierInvoiceRef" TEXT NOT NULL,
 "description" TEXT NOT NULL, "issuedAt" TIMESTAMP(3) NOT NULL, "dueAt" TIMESTAMP(3) NOT NULL,
 "amountMinor" INTEGER NOT NULL, "currency" "Currency" NOT NULL DEFAULT 'PKR',
 "status" "PharmacySupplierExpenseInvoiceStatus" NOT NULL DEFAULT 'OPEN', "idempotencyKey" TEXT NOT NULL,
 "journalEntryId" TEXT NOT NULL, "createdByUserId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "pharmacy_supplier_expense_invoices_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "pharmacy_supplier_expense_invoices_amount_check" CHECK ("amountMinor" > 0),
 CONSTRAINT "pharmacy_supplier_expense_invoices_dates_check" CHECK ("dueAt" >= "issuedAt"),
 CONSTRAINT "pharmacy_supplier_expense_invoices_supplier_fkey" FOREIGN KEY ("organizationId","supplierId") REFERENCES "pharmacy_suppliers"("organizationId","id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "pharmacy_supplier_expense_invoices_journal_fkey" FOREIGN KEY ("organizationId","journalEntryId") REFERENCES "finance_journal_entries"("organizationId","id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "pharmacy_supplier_expense_invoices_branch_fkey" FOREIGN KEY ("organizationId","branchId") REFERENCES "pharmacy_branches"("organizationId","id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "pharmacy_supplier_expense_invoices_org_id_key" ON "pharmacy_supplier_expense_invoices"("organizationId","id");
CREATE UNIQUE INDEX "pharmacy_supplier_expense_invoices_identity_key" ON "pharmacy_supplier_expense_invoices"("organizationId","supplierId","supplierInvoiceRef");
CREATE UNIQUE INDEX "pharmacy_supplier_expense_invoices_idempotency_key" ON "pharmacy_supplier_expense_invoices"("organizationId","idempotencyKey");
CREATE INDEX "pharmacy_supplier_expense_invoices_aging_idx" ON "pharmacy_supplier_expense_invoices"("organizationId","branchId","dueAt","id");

CREATE TABLE "pharmacy_supplier_expense_invoice_lines" (
 "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true), "invoiceId" TEXT NOT NULL,
 "description" TEXT NOT NULL, "amountMinor" INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "pharmacy_supplier_expense_invoice_lines_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "pharmacy_supplier_expense_invoice_lines_amount_check" CHECK ("amountMinor" > 0),
 CONSTRAINT "pharmacy_supplier_expense_invoice_lines_invoice_fkey" FOREIGN KEY ("organizationId","invoiceId") REFERENCES "pharmacy_supplier_expense_invoices"("organizationId","id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "pharmacy_supplier_expense_invoice_lines_org_id_key" ON "pharmacy_supplier_expense_invoice_lines"("organizationId","id");
CREATE INDEX "pharmacy_supplier_expense_invoice_lines_invoice_idx" ON "pharmacy_supplier_expense_invoice_lines"("organizationId","invoiceId");

CREATE TABLE "pharmacy_supplier_expense_settlements" (
 "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true), "invoiceId" TEXT NOT NULL,
 "bookkeepingTransactionId" TEXT NOT NULL, "amountMinor" INTEGER NOT NULL, "status" "PharmacySupplierExpenseSettlementStatus" NOT NULL DEFAULT 'POSTED',
 "idempotencyKey" TEXT NOT NULL, "reference" TEXT NOT NULL, "fundingAccount" TEXT NOT NULL,
 "occurredAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "pharmacy_supplier_expense_settlements_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "pharmacy_supplier_expense_settlements_amount_check" CHECK ("amountMinor" > 0),
 CONSTRAINT "pharmacy_supplier_expense_settlements_invoice_fkey" FOREIGN KEY ("organizationId","invoiceId") REFERENCES "pharmacy_supplier_expense_invoices"("organizationId","id") ON DELETE RESTRICT,
 CONSTRAINT "pharmacy_supplier_expense_settlements_transaction_fkey" FOREIGN KEY ("organizationId","bookkeepingTransactionId") REFERENCES "pharmacy_bookkeeping_transactions"("organizationId","id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pharmacy_supplier_expense_settlements_org_id_key" ON "pharmacy_supplier_expense_settlements"("organizationId","id");
CREATE UNIQUE INDEX "pharmacy_supplier_expense_settlements_idempotency_key" ON "pharmacy_supplier_expense_settlements"("organizationId","idempotencyKey");
CREATE UNIQUE INDEX "pharmacy_supplier_expense_settlements_transaction_key" ON "pharmacy_supplier_expense_settlements"("organizationId","bookkeepingTransactionId");
CREATE INDEX "pharmacy_supplier_expense_settlements_invoice_idx" ON "pharmacy_supplier_expense_settlements"("organizationId","invoiceId","occurredAt");

CREATE TABLE "pharmacy_supplier_expense_settlement_reversals" (
 "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true), "settlementId" TEXT NOT NULL,
 "idempotencyKey" TEXT NOT NULL, "reason" TEXT NOT NULL, "reversedAt" TIMESTAMP(3) NOT NULL, "createdByUserId" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "pharmacy_supplier_expense_settlement_reversals_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "pharmacy_supplier_expense_settlement_reversals_settlement_fkey" FOREIGN KEY ("organizationId","settlementId") REFERENCES "pharmacy_supplier_expense_settlements"("organizationId","id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "pharmacy_supplier_expense_settlement_reversals_org_id_key" ON "pharmacy_supplier_expense_settlement_reversals"("organizationId","id");
CREATE UNIQUE INDEX "pharmacy_supplier_expense_settlement_reversals_idempotency_key" ON "pharmacy_supplier_expense_settlement_reversals"("organizationId","idempotencyKey");
CREATE UNIQUE INDEX "pharmacy_supplier_expense_settlement_reversals_settlement_key" ON "pharmacy_supplier_expense_settlement_reversals"("organizationId","settlementId");

CREATE TABLE "pharmacy_supplier_expense_invoice_events" (
 "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true), "invoiceId" TEXT NOT NULL,
 "kind" TEXT NOT NULL, "actorId" TEXT NOT NULL, "occurredAt" TIMESTAMP(3) NOT NULL, "detail" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "pharmacy_supplier_expense_invoice_events_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "pharmacy_supplier_expense_invoice_events_invoice_fkey" FOREIGN KEY ("organizationId","invoiceId") REFERENCES "pharmacy_supplier_expense_invoices"("organizationId","id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "pharmacy_supplier_expense_invoice_events_org_id_key" ON "pharmacy_supplier_expense_invoice_events"("organizationId","id");
CREATE INDEX "pharmacy_supplier_expense_invoice_events_invoice_idx" ON "pharmacy_supplier_expense_invoice_events"("organizationId","invoiceId","occurredAt");

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY[
 'pharmacy_supplier_expense_invoices','pharmacy_supplier_expense_invoice_lines','pharmacy_supplier_expense_settlements',
 'pharmacy_supplier_expense_settlement_reversals','pharmacy_supplier_expense_invoice_events'
] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
 EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.is_platform_admin'',true)=''true'' OR "organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),'''')) WITH CHECK (current_setting(''app.is_platform_admin'',true)=''true'' OR "organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),''''))',t);
END LOOP; END $$;
