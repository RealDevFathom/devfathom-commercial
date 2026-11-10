-- Bind every browser receipt-copy allocation to the operator and locale that
-- requested it, so a dispatch confirmation can only be recorded by that
-- operator for that allocation. Additive: existing tables and rows are untouched.
BEGIN;

CREATE TABLE IF NOT EXISTS "pharmacy_receipt_print_allocations" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "copyNumber" INTEGER NOT NULL,
  "actorId" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_receipt_print_allocations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_receipt_print_allocations_sale_fkey" FOREIGN KEY ("organizationId", "branchId", "saleId") REFERENCES "pharmacy_sales"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_receipt_print_allocations_copy_number_check" CHECK ("copyNumber" > 0),
  CONSTRAINT "pharmacy_receipt_print_allocations_locale_check" CHECK ("locale" IN ('en', 'ur'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_receipt_print_allocations_copy_key" ON "pharmacy_receipt_print_allocations"("organizationId", "branchId", "saleId", "copyNumber");

-- Allocations are evidence of who reserved each copy; they are immutable too.
DROP TRIGGER IF EXISTS pharmacy_receipt_print_allocations_append_only ON "pharmacy_receipt_print_allocations";
CREATE TRIGGER pharmacy_receipt_print_allocations_append_only
BEFORE UPDATE OR DELETE ON "pharmacy_receipt_print_allocations"
FOR EACH ROW EXECUTE FUNCTION reject_pharmacy_receipt_print_dispatch_mutation();

ALTER TABLE "pharmacy_receipt_print_allocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_receipt_print_allocations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_branch_isolation ON "pharmacy_receipt_print_allocations";
CREATE POLICY tenant_branch_isolation ON "pharmacy_receipt_print_allocations"
  USING (current_setting('app.is_platform_admin', true) = 'true' OR ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR "branchId" = current_setting('app.current_branch_id', true))))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR "branchId" = current_setting('app.current_branch_id', true))));

COMMIT;
