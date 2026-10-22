ALTER TABLE "pharmacy_drawer_movements"
  ADD COLUMN "operationKey" TEXT;

CREATE UNIQUE INDEX "pharmacy_drawer_movements_org_operation_key"
  ON "pharmacy_drawer_movements"("organizationId", "operationKey");
