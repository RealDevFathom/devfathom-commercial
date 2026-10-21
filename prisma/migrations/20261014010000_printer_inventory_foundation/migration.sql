-- Inventory-only derivative. Existing address-valued route/job printerId is untouched.
CREATE TYPE "RestaurantPrinterConnectionKind" AS ENUM ('TCP', 'DEVICE_PATH', 'QUEUE');
CREATE TYPE "RestaurantPrinterStatus" AS ENUM ('ONLINE', 'OFFLINE');
CREATE TABLE "restaurant_printers" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "bridgeId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "connectionKind" "RestaurantPrinterConnectionKind" NOT NULL,
  "address" TEXT NOT NULL,
  "paperWidthMm" INTEGER NOT NULL,
  "status" "RestaurantPrinterStatus" NOT NULL DEFAULT 'OFFLINE',
  "lastSeenAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "restaurant_printers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_printers_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches"("organizationId", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "restaurant_printers_bridge_fkey" FOREIGN KEY ("organizationId", "branchId", "bridgeId") REFERENCES "restaurant_registered_devices"("organizationId", "branchId", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "restaurant_printers_paper_width_check" CHECK ("paperWidthMm" IN (58, 80))
);
CREATE UNIQUE INDEX "restaurant_printers_organizationId_id_key" ON "restaurant_printers"("organizationId", "id");
CREATE INDEX "restaurant_printers_organizationId_bridgeId_idx" ON "restaurant_printers"("organizationId", "bridgeId");
CREATE INDEX "restaurant_printers_organizationId_branchId_idx" ON "restaurant_printers"("organizationId", "branchId");
ALTER TABLE "restaurant_printers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_printers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_printers" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
