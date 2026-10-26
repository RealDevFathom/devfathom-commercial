CREATE TABLE "pharmacy_receipt_print_states" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "copyCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_receipt_print_states_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_receipt_print_states_sale_fkey" FOREIGN KEY ("organizationId", "branchId", "saleId") REFERENCES "pharmacy_sales"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_receipt_print_states_copy_count_check" CHECK ("copyCount" >= 0)
);

CREATE UNIQUE INDEX "pharmacy_receipt_print_states_sale_key" ON "pharmacy_receipt_print_states"("organizationId", "branchId", "saleId");

CREATE TABLE "pharmacy_receipt_print_dispatches" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "copyNumber" INTEGER NOT NULL,
  "actorId" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_receipt_print_dispatches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_receipt_print_dispatches_sale_fkey" FOREIGN KEY ("organizationId", "branchId", "saleId") REFERENCES "pharmacy_sales"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_receipt_print_dispatches_copy_number_check" CHECK ("copyNumber" > 0),
  CONSTRAINT "pharmacy_receipt_print_dispatches_locale_check" CHECK ("locale" IN ('en', 'ur'))
);

CREATE UNIQUE INDEX "pharmacy_receipt_print_dispatches_copy_key" ON "pharmacy_receipt_print_dispatches"("organizationId", "branchId", "saleId", "copyNumber");
CREATE INDEX "pharmacy_receipt_print_dispatches_branch_created_idx" ON "pharmacy_receipt_print_dispatches"("organizationId", "branchId", "createdAt");

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['pharmacy_receipt_print_states', 'pharmacy_receipt_print_dispatches'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_branch_isolation ON %I USING (current_setting(''app.is_platform_admin'', true) = ''true'' OR ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''') AND (NULLIF(current_setting(''app.current_branch_id'', true), '''') IS NULL OR "branchId" = current_setting(''app.current_branch_id'', true)))) WITH CHECK (current_setting(''app.is_platform_admin'', true) = ''true'' OR ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''') AND (NULLIF(current_setting(''app.current_branch_id'', true), '''') IS NULL OR "branchId" = current_setting(''app.current_branch_id'', true))))',
      table_name
    );
  END LOOP;
END $$;
