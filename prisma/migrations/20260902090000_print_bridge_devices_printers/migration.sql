ALTER TYPE "RestaurantDeviceKind" ADD VALUE 'PRINT_BRIDGE';

CREATE TYPE "RestaurantPrinterConnectionKind" AS ENUM ('TCP', 'DEVICE_PATH');
CREATE TYPE "RestaurantPrinterStatus" AS ENUM ('ONLINE', 'OFFLINE');

CREATE TABLE "restaurant_print_bridge_enrollment_codes" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "deviceId" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "restaurant_print_bridge_enrollment_codes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_print_bridge_enrollment_codes_device_fkey" FOREIGN KEY ("organizationId", "deviceId") REFERENCES "restaurant_registered_devices"("organizationId", "id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "restaurant_print_bridge_enrollment_codes_codeHash_key" ON "restaurant_print_bridge_enrollment_codes"("codeHash");
CREATE INDEX "restaurant_print_bridge_enrollment_codes_organizationId_deviceId_idx" ON "restaurant_print_bridge_enrollment_codes"("organizationId", "deviceId");

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
  CONSTRAINT "restaurant_printers_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches"("organizationId", "id") ON DELETE CASCADE,
  CONSTRAINT "restaurant_printers_bridge_fkey" FOREIGN KEY ("organizationId", "bridgeId") REFERENCES "restaurant_registered_devices"("organizationId", "id") ON DELETE CASCADE,
  CONSTRAINT "restaurant_printers_paper_width_check" CHECK ("paperWidthMm" IN (58, 80))
);
CREATE UNIQUE INDEX "restaurant_printers_organizationId_id_key" ON "restaurant_printers"("organizationId", "id");
CREATE INDEX "restaurant_printers_organizationId_bridgeId_idx" ON "restaurant_printers"("organizationId", "bridgeId");
CREATE INDEX "restaurant_printers_organizationId_branchId_idx" ON "restaurant_printers"("organizationId", "branchId");

ALTER TABLE "restaurant_print_routes" ADD CONSTRAINT "restaurant_print_routes_printer_fkey" FOREIGN KEY ("organizationId", "printerId") REFERENCES "restaurant_printers"("organizationId", "id") ON DELETE RESTRICT NOT VALID;
ALTER TABLE "restaurant_print_jobs" ADD CONSTRAINT "restaurant_print_jobs_printer_fkey" FOREIGN KEY ("organizationId", "printerId") REFERENCES "restaurant_printers"("organizationId", "id") ON DELETE RESTRICT NOT VALID;

ALTER TABLE "restaurant_print_bridge_enrollment_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_print_bridge_enrollment_codes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_print_bridge_enrollment_codes" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_printers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_printers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_printers" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
