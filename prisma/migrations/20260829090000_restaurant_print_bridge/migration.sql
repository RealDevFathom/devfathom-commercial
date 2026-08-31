CREATE TYPE "RestaurantPrintDocumentType" AS ENUM ('KITCHEN_TICKET', 'BAR_TICKET', 'RECEIPT');
CREATE TYPE "RestaurantPrintJobStatus" AS ENUM ('PENDING', 'OFFLINE', 'NO_PRINTER', 'PRINTED');

CREATE TABLE "restaurant_print_routes" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "stationId" TEXT,
  "documentType" "RestaurantPrintDocumentType" NOT NULL,
  "printerId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "restaurant_print_routes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_print_routes_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches"("organizationId", "id") ON DELETE CASCADE,
  CONSTRAINT "restaurant_print_routes_station_fkey" FOREIGN KEY ("organizationId", "stationId") REFERENCES "restaurant_kitchen_stations"("organizationId", "id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "restaurant_print_routes_scope_key" ON "restaurant_print_routes"("organizationId", "branchId", "stationId", "documentType") NULLS NOT DISTINCT;
CREATE INDEX "restaurant_print_routes_organizationId_branchId_idx" ON "restaurant_print_routes"("organizationId", "branchId");

CREATE TABLE "restaurant_print_jobs" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "stationId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "documentType" "RestaurantPrintDocumentType" NOT NULL,
  "document" JSONB NOT NULL,
  "status" "RestaurantPrintJobStatus" NOT NULL DEFAULT 'PENDING',
  "printerId" TEXT,
  "byteCount" INTEGER,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt" TIMESTAMP(3),
  "printedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "restaurant_print_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_print_jobs_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches"("organizationId", "id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "restaurant_print_jobs_replay_key" ON "restaurant_print_jobs"("organizationId", "branchId", "idempotencyKey");
CREATE INDEX "restaurant_print_jobs_organizationId_status_createdAt_idx" ON "restaurant_print_jobs"("organizationId", "status", "createdAt");

ALTER TABLE "restaurant_print_routes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_print_routes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_print_routes"
  USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_print_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_print_jobs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_print_jobs"
  USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
