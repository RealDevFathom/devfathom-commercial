-- Keep the captured per-canonical-unit price through fractional pack division.
-- Capture, partial recovery and expiry all round only the final PKR loss.
ALTER TABLE "pharmacy_unfulfilled_demand_events"
  ALTER COLUMN "unitPricePkr" TYPE DECIMAL(24,12);

CREATE UNIQUE INDEX "ph_demand_org_branch_id_key"
  ON "pharmacy_unfulfilled_demand_events"("organizationId", "branchId", id);

CREATE TABLE "pharmacy_demand_recoveries" (
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "demandId" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "canonicalUnits" INTEGER NOT NULL CHECK ("canonicalUnits" > 0),
  CONSTRAINT "ph_demand_recovery_pkey" PRIMARY KEY ("organizationId", "branchId", "demandId", "saleId"),
  CONSTRAINT "ph_demand_recovery_demand_fk" FOREIGN KEY ("organizationId", "branchId", "demandId")
    REFERENCES "pharmacy_unfulfilled_demand_events"("organizationId", "branchId", id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ph_demand_recovery_sale_fk" FOREIGN KEY ("organizationId", "branchId", "saleId")
    REFERENCES "pharmacy_sales"("organizationId", "branchId", id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ph_demand_recovery_sale_idx"
  ON "pharmacy_demand_recoveries"("organizationId", "branchId", "saleId");

ALTER TABLE "pharmacy_demand_recoveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_demand_recoveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pharmacy_demand_recoveries"
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
