-- #716 — owner full data export ("no lock-in" button).
--
-- Additive only. One request row per owner export; the platform worker builds
-- the archive and records where it is stored. The new PlatformJobType value is
-- added but not used in this migration, so ALTER TYPE ... ADD VALUE is safe
-- inside the migration transaction.

-- AlterEnum
ALTER TYPE "PlatformJobType" ADD VALUE 'pharmacy.data.export.v1';

-- CreateEnum
CREATE TYPE "PharmacyDataExportStatus" AS ENUM ('QUEUED', 'READY', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "pharmacy_data_exports" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "requestedByUserId" TEXT NOT NULL,
    "status" "PharmacyDataExportStatus" NOT NULL DEFAULT 'QUEUED',
    "salesFrom" DATE NOT NULL,
    "salesTo" DATE NOT NULL,
    "storageKey" TEXT,
    "fileName" TEXT,
    "sizeBytes" INTEGER,
    "sha256" TEXT,
    "rowCounts" JSONB,
    "error" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "lastDownloadedAt" TIMESTAMP(3),

    CONSTRAINT "pharmacy_data_exports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pharmacy_data_exports_range_check" CHECK ("salesFrom" <= "salesTo"),
    CONSTRAINT "pharmacy_data_exports_download_count_check" CHECK ("downloadCount" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_data_exports_org_id_key" ON "pharmacy_data_exports"("organizationId", "id");
CREATE INDEX "pharmacy_data_exports_org_requested_idx" ON "pharmacy_data_exports"("organizationId", "requestedAt");
CREATE INDEX "pharmacy_data_exports_status_expiry_idx" ON "pharmacy_data_exports"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "pharmacy_data_exports" ADD CONSTRAINT "pharmacy_data_exports_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row level security: organization is the tenant boundary; the platform worker
-- reaches the row only under app.is_platform_admin and narrows to the tenant
-- before reading any pharmacy data.
ALTER TABLE "pharmacy_data_exports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_data_exports" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pharmacy_data_exports"
  USING (current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
