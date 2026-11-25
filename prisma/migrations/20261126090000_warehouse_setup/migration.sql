BEGIN;

ALTER TABLE pharmacy_branches
  ADD COLUMN "warehouseEnabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN "warehouseMinimumShelfLifeDays" integer NOT NULL DEFAULT 0
    CHECK ("warehouseMinimumShelfLifeDays" >= 0);
ALTER TABLE pharmacy_stock_locations
  ADD COLUMN "warehouseStaging" boolean NOT NULL DEFAULT false;

CREATE TYPE "PharmacyWarehouseRequestStatus" AS ENUM
  ('REQUESTED', 'ALLOCATED', 'DIRECT_PURCHASE', 'REQUISITIONED', 'CANCELLED');

CREATE TABLE pharmacy_warehouse_requests (
  id text PRIMARY KEY,
  "organizationId" text NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "warehouseBranchId" text NOT NULL,
  "branchId" text NOT NULL,
  "destinationStockLocationId" text NOT NULL,
  "medicineId" text NOT NULL,
  "requestedUnits" integer NOT NULL CHECK ("requestedUnits" > 0),
  status "PharmacyWarehouseRequestStatus" NOT NULL,
  "requestedById" text NOT NULL,
  "signalId" text,
  "idempotencyKey" text NOT NULL,
  "orderId" text,
  "requisitionId" text,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ph_wh_request_retry_key UNIQUE ("organizationId","branchId","idempotencyKey"),
  CONSTRAINT ph_wh_request_signal_key UNIQUE ("organizationId","signalId"),
  CHECK ("warehouseBranchId" <> "branchId"),
  FOREIGN KEY ("organizationId","warehouseBranchId") REFERENCES pharmacy_branches ("organizationId",id) ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("organizationId","branchId") REFERENCES pharmacy_branches ("organizationId",id) ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("organizationId","medicineId") REFERENCES pharmacy_medicines ("organizationId",id) ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("organizationId","branchId","destinationStockLocationId") REFERENCES pharmacy_stock_locations ("organizationId","branchId",id),
  FOREIGN KEY ("organizationId","requisitionId") REFERENCES pharmacy_requisitions ("organizationId",id),
  FOREIGN KEY ("organizationId","branchId","signalId") REFERENCES pharmacy_stock_signals ("organizationId","branchId",id)
);
CREATE INDEX ph_wh_request_source_idx ON pharmacy_warehouse_requests ("organizationId","warehouseBranchId",status);
CREATE INDEX ph_wh_request_dest_idx ON pharmacy_warehouse_requests ("organizationId","branchId","createdAt");

ALTER TABLE pharmacy_warehouse_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_warehouse_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pharmacy_warehouse_requests
  USING (current_setting('app.is_platform_admin',true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id',true),'')
      AND (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL
        OR current_setting('app.current_branch_id',true) IN ("warehouseBranchId","branchId"))));

COMMIT;
