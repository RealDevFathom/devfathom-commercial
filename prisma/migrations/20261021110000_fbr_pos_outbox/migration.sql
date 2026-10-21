ALTER TABLE pharmacy_sales ADD COLUMN "fbrStatus" TEXT,
  ADD COLUMN "fbrInvoiceNumber" TEXT;
ALTER TABLE pharmacy_sales ADD CONSTRAINT pharmacy_sales_fbr_state_check CHECK (COALESCE((
  ("fbrStatus" IS NULL AND "fbrInvoiceNumber" IS NULL) OR
  ("fbrStatus" = 'PENDING' AND "fbrInvoiceNumber" IS NULL) OR
  ("fbrStatus" = 'SUBMITTED' AND "fbrInvoiceNumber" IS NOT NULL)
), false));
CREATE TABLE fiscal_invoice_outbox (
  id TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  authority TEXT NOT NULL DEFAULT 'FBR' CHECK (authority = 'FBR'),
  mode TEXT NOT NULL DEFAULT 'MOCK' CHECK (mode = 'MOCK'),
  usin VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SUBMITTED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "submittedAt" TIMESTAMP(3),
  UNIQUE ("organizationId", "saleId"),
  UNIQUE ("organizationId", usin),
  FOREIGN KEY ("organizationId", "branchId", "saleId") REFERENCES pharmacy_sales ("organizationId", "branchId", id) ON DELETE RESTRICT
);
CREATE INDEX fiscal_invoice_outbox_due ON fiscal_invoice_outbox ("organizationId", "branchId", status, "nextAttemptAt");
ALTER TABLE fiscal_invoice_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_invoice_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY fiscal_invoice_outbox_tenant_isolation ON fiscal_invoice_outbox
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
