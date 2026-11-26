BEGIN;

ALTER TYPE "PharmacyStockDisposition" ADD VALUE IF NOT EXISTS 'WAREHOUSE_RECEIVING';

CREATE TABLE pharmacy_warehouse_putaways (
  id TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "goodsReceiptLineId" TEXT NOT NULL,
  "quantityUnits" INTEGER NOT NULL CHECK ("quantityUnits" > 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "completedById" TEXT,
  "destinationCode" TEXT,
  "productScan" TEXT,
  "batchScan" TEXT,
  CONSTRAINT pharmacy_wh_putaway_line_fk FOREIGN KEY ("organizationId","branchId","goodsReceiptLineId")
    REFERENCES pharmacy_goods_receipt_lines ("organizationId","branchId",id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT pharmacy_wh_putaway_line_key UNIQUE ("organizationId","branchId","goodsReceiptLineId"),
  CONSTRAINT pharmacy_wh_putaway_completion_check CHECK (
    num_nonnulls("completedAt","completedById","destinationCode","productScan","batchScan") IN (0,5)
  )
);
CREATE INDEX pharmacy_wh_putaway_queue_idx ON pharmacy_warehouse_putaways
  ("organizationId","branchId","completedAt","createdAt");

ALTER TABLE pharmacy_warehouse_putaways ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_warehouse_putaways FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_branch_isolation ON pharmacy_warehouse_putaways
  USING (current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
    (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
      "branchId" = current_setting('app.current_branch_id', true))))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
    (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
      "branchId" = current_setting('app.current_branch_id', true))));

COMMIT;
