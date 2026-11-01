-- Platform default medicine catalogue.
--
-- Two platform tables hold the shared, versioned catalogue. They are reference
-- data, not tenant data: no organizationId, readable by every session, written
-- only under the platform-admin GUC, never deleted through the application role
-- except by the platform. A tenant copies items into its own pharmacy_medicines
-- (stock zero), and pharmacy_medicine_catalogue_provenance records each copy so
-- re-applying a catalogue never duplicates or overwrites a tenant medicine.

-- The new job type is not used anywhere else in this migration, so adding the
-- enum value inside the migration transaction is safe.
ALTER TYPE "PlatformJobType" ADD VALUE 'pharmacy.default-catalogue.v1';

CREATE TABLE "platform_medicine_catalogue_versions" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "digest" TEXT NOT NULL,
  "rowCount" INTEGER NOT NULL,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_medicine_catalogue_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_medicine_catalogue_versions_shape_check" CHECK (
    length(btrim("key")) BETWEEN 1 AND 100
    AND "version" > 0
    AND "digest" ~ '^[0-9a-f]{64}$'
    AND "rowCount" >= 0
  )
);
CREATE UNIQUE INDEX "platform_medicine_catalogue_versions_key_version_key"
  ON "platform_medicine_catalogue_versions" ("key", "version");
CREATE UNIQUE INDEX "platform_medicine_catalogue_versions_key_digest_key"
  ON "platform_medicine_catalogue_versions" ("key", "digest");

CREATE TABLE "platform_medicine_catalogue_items" (
  "id" TEXT NOT NULL,
  "versionId" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "productName" TEXT NOT NULL,
  "brandName" TEXT,
  "manufacturer" TEXT,
  "strength" TEXT,
  "dosageForm" TEXT,
  "productFamily" "PharmacyProductFamily" NOT NULL,
  "controlledCandidate" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_medicine_catalogue_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_medicine_catalogue_items_versionId_fkey" FOREIGN KEY ("versionId")
    REFERENCES "platform_medicine_catalogue_versions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "platform_medicine_catalogue_items_text_check" CHECK (
    length(btrim("sourceKey")) BETWEEN 1 AND 200
    AND length(btrim("productName")) BETWEEN 1 AND 300
  )
);
CREATE UNIQUE INDEX "platform_medicine_catalogue_items_version_source_key"
  ON "platform_medicine_catalogue_items" ("versionId", "sourceKey");

CREATE TABLE "pharmacy_medicine_catalogue_provenance" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "medicineId" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'platform-default',
  "catalogueKey" TEXT NOT NULL,
  "catalogueVersion" INTEGER NOT NULL,
  "catalogueVersionId" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "contentDigest" TEXT NOT NULL,
  "controlledCandidate" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_medicine_catalogue_provenance_pkey" PRIMARY KEY ("id"),
  -- Composite, so a provenance row can only ever name its own tenant's medicine.
  CONSTRAINT "pharmacy_medicine_catalogue_provenance_medicine_fkey"
    FOREIGN KEY ("organizationId", "medicineId")
    REFERENCES "pharmacy_medicines" ("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_medicine_catalogue_provenance_version_fkey"
    FOREIGN KEY ("catalogueVersionId")
    REFERENCES "platform_medicine_catalogue_versions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pharmacy_medicine_catalogue_provenance_org_source_key"
  ON "pharmacy_medicine_catalogue_provenance" ("organizationId", "catalogueKey", "sourceKey");
CREATE UNIQUE INDEX "pharmacy_medicine_catalogue_provenance_org_medicine_key"
  ON "pharmacy_medicine_catalogue_provenance" ("organizationId", "medicineId");
CREATE INDEX "pharmacy_medicine_catalogue_provenance_org_controlled_idx"
  ON "pharmacy_medicine_catalogue_provenance" ("organizationId", "controlledCandidate");

-- Shared reference data: every session reads, only the platform writes.
ALTER TABLE "platform_medicine_catalogue_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_medicine_catalogue_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "medicine_catalogue_versions_read" ON "platform_medicine_catalogue_versions"
  FOR SELECT USING (true);
CREATE POLICY "medicine_catalogue_versions_platform_insert" ON "platform_medicine_catalogue_versions"
  FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
CREATE POLICY "medicine_catalogue_versions_platform_update" ON "platform_medicine_catalogue_versions"
  FOR UPDATE
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
CREATE POLICY "medicine_catalogue_versions_platform_delete" ON "platform_medicine_catalogue_versions"
  FOR DELETE USING (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE "platform_medicine_catalogue_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_medicine_catalogue_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "medicine_catalogue_items_read" ON "platform_medicine_catalogue_items"
  FOR SELECT USING (true);
CREATE POLICY "medicine_catalogue_items_platform_insert" ON "platform_medicine_catalogue_items"
  FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
CREATE POLICY "medicine_catalogue_items_platform_delete" ON "platform_medicine_catalogue_items"
  FOR DELETE USING (current_setting('app.is_platform_admin', true) = 'true');

-- Tenant data: the standard isolation policy.
ALTER TABLE "pharmacy_medicine_catalogue_provenance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_medicine_catalogue_provenance" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "pharmacy_medicine_catalogue_provenance"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );
