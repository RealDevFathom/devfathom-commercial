-- PH-P1 INV-10 / PLAT-04 / §8A invariant 29: narrow chain-purchasing access
-- and allocation evidence. Stock moves only through INV-07 transfers.
CREATE TABLE "pharmacy_central_purchasing_access" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "userId" TEXT NOT NULL,
  "branchId" TEXT,
  "grantedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_central_purchasing_access_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_central_purchasing_access_branch_fkey" FOREIGN KEY ("organizationId","branchId") REFERENCES "pharmacy_branches"("organizationId","id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "pharmacy_central_purchasing_access_org_id_key" ON "pharmacy_central_purchasing_access"("organizationId","id");
CREATE INDEX "pharmacy_central_purchasing_access_scope_idx" ON "pharmacy_central_purchasing_access"("organizationId","userId","branchId");
CREATE UNIQUE INDEX "pharmacy_central_purchasing_access_org_user_key" ON "pharmacy_central_purchasing_access"("organizationId","userId") WHERE "branchId" IS NULL;

CREATE TABLE "pharmacy_central_purchase_allocations" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "sourceBranchId" TEXT NOT NULL,
  "destinationBranchId" TEXT NOT NULL,
  "goodsReceiptLineId" TEXT NOT NULL,
  "transferId" TEXT NOT NULL,
  "transferLineId" TEXT NOT NULL,
  "quantityUnits" INTEGER NOT NULL,
  "allocatedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_central_purchase_allocations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_central_purchase_allocations_positive" CHECK ("quantityUnits" > 0),
  CONSTRAINT "pharmacy_central_purchase_allocations_distinct_branches" CHECK ("sourceBranchId" <> "destinationBranchId"),
  CONSTRAINT "pharmacy_central_purchase_allocations_source_fkey" FOREIGN KEY ("organizationId","sourceBranchId") REFERENCES "pharmacy_branches"("organizationId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_central_purchase_allocations_destination_fkey" FOREIGN KEY ("organizationId","destinationBranchId") REFERENCES "pharmacy_branches"("organizationId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_central_purchase_allocations_receipt_line_fkey" FOREIGN KEY ("organizationId","sourceBranchId","goodsReceiptLineId") REFERENCES "pharmacy_goods_receipt_lines"("organizationId","branchId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_central_purchase_allocations_transfer_fkey" FOREIGN KEY ("organizationId","transferId") REFERENCES "pharmacy_interbranch_transfers"("organizationId","id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "pharmacy_central_purchase_allocations_org_id_key" ON "pharmacy_central_purchase_allocations"("organizationId","id");
CREATE UNIQUE INDEX "pharmacy_central_purchase_allocations_once_key" ON "pharmacy_central_purchase_allocations"("organizationId","goodsReceiptLineId","destinationBranchId");
CREATE INDEX "pharmacy_central_purchase_allocations_source_idx" ON "pharmacy_central_purchase_allocations"("organizationId","sourceBranchId","createdAt");
CREATE INDEX "pharmacy_central_purchase_allocations_destination_idx" ON "pharmacy_central_purchase_allocations"("organizationId","destinationBranchId","createdAt");

ALTER TABLE "pharmacy_central_purchasing_access" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_central_purchasing_access" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_branch_isolation" ON "pharmacy_central_purchasing_access"
  USING (current_setting('app.is_platform_admin',true)='true' OR ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR "branchId" IS NULL OR "branchId"=NULLIF(current_setting('app.current_branch_id',true),''))))
  WITH CHECK (current_setting('app.is_platform_admin',true)='true' OR ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR "branchId" IS NULL OR "branchId"=NULLIF(current_setting('app.current_branch_id',true),''))));
ALTER TABLE "pharmacy_central_purchase_allocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_central_purchase_allocations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_branch_isolation" ON "pharmacy_central_purchase_allocations"
  USING (current_setting('app.is_platform_admin',true)='true' OR ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR NULLIF(current_setting('app.current_branch_id',true),'') IN ("sourceBranchId","destinationBranchId"))))
  WITH CHECK (current_setting('app.is_platform_admin',true)='true' OR ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR NULLIF(current_setting('app.current_branch_id',true),'') IN ("sourceBranchId","destinationBranchId"))));
