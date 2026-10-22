CREATE TABLE "pharmacy_receipt_print_attempts" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "copyNumber" INTEGER NOT NULL,
  "requestedById" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_receipt_print_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_receipt_print_attempts_copy_positive" CHECK ("copyNumber" > 0),
  CONSTRAINT "pharmacy_receipt_print_attempts_locale_check" CHECK ("locale" IN ('en', 'ur')),
  CONSTRAINT "pharmacy_receipt_print_attempts_sale_fkey" FOREIGN KEY ("organizationId", "branchId", "saleId") REFERENCES "pharmacy_sales"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "pharmacy_receipt_print_attempts_sale_copy_key" ON "pharmacy_receipt_print_attempts"("organizationId", "saleId", "copyNumber");
CREATE INDEX "pharmacy_receipt_print_attempts_branch_created_idx" ON "pharmacy_receipt_print_attempts"("organizationId", "branchId", "createdAt");
ALTER TABLE "pharmacy_receipt_print_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_receipt_print_attempts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pharmacy_receipt_print_attempts"
  USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
