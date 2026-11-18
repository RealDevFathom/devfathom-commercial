BEGIN;

-- DEV-912: catalogue medicines created in bulk from a staged legacy product file.
-- One row per source row: the source row identity (`sourceKey` binds the uploaded
-- bytes' SHA-256 and the row number) is unique per organization, so running the
-- creation again for the same file, even from a second batch of the same bytes,
-- creates nothing twice. The record keeps the imported pack MRP and purchase price
-- as they were read; a null means the file did not record it.
CREATE TABLE IF NOT EXISTS "pharmacy_staged_medicine_links" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "sourceKey" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "rowId" TEXT NOT NULL,
  "editId" TEXT NOT NULL REFERENCES "pharmacy_catalogue_edits"("id") ON DELETE RESTRICT,
  "medicineId" TEXT NOT NULL,
  "packLevelId" TEXT,
  "unitsPerPack" INTEGER CHECK ("unitsPerPack" IS NULL OR "unitsPerPack" > 0),
  "mrpMinor" INTEGER CHECK ("mrpMinor" IS NULL OR "mrpMinor" >= 0),
  "purchasePriceMinor" INTEGER CHECK ("purchasePriceMinor" IS NULL OR "purchasePriceMinor" >= 0),
  "legacyCode" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("organizationId", "batchId") REFERENCES "pharmacy_migration_batches"("organizationId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "rowId") REFERENCES "pharmacy_migration_rows"("organizationId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "medicineId") REFERENCES "pharmacy_medicines"("organizationId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "packLevelId") REFERENCES "pharmacy_pack_levels"("organizationId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "createdById") REFERENCES "users"("organizationId", "id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_staged_medicine_links_organizationId_sourceKey_key"
  ON "pharmacy_staged_medicine_links" ("organizationId", "sourceKey");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_staged_medicine_links_organizationId_medicineId_key"
  ON "pharmacy_staged_medicine_links" ("organizationId", "medicineId");
CREATE INDEX IF NOT EXISTS "pharmacy_staged_medicine_links_organizationId_batchId_idx"
  ON "pharmacy_staged_medicine_links" ("organizationId", "batchId");

-- Tenant isolation. The record is evidence: it can be read and added, never changed or removed.
ALTER TABLE "pharmacy_staged_medicine_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_staged_medicine_links" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "pharmacy_staged_medicine_links";
DROP POLICY IF EXISTS tenant_read ON "pharmacy_staged_medicine_links";
CREATE POLICY tenant_read ON "pharmacy_staged_medicine_links" FOR SELECT
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
DROP POLICY IF EXISTS tenant_insert ON "pharmacy_staged_medicine_links";
CREATE POLICY tenant_insert ON "pharmacy_staged_medicine_links" FOR INSERT
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

-- A bulk creation request names a staged batch, not one medicine, like a new ingredient.
ALTER TABLE "pharmacy_catalogue_edits"
  DROP CONSTRAINT IF EXISTS "pharmacy_catalogue_edits_medicine_scope_check";
ALTER TABLE "pharmacy_catalogue_edits"
  ADD CONSTRAINT "pharmacy_catalogue_edits_medicine_scope_check"
  CHECK (("operation" IN ('createIngredient', 'createStagedMedicines')) = ("medicineId" IS NULL));

-- An MRP read from an approved import is a fourth, named source of price policy.
ALTER TABLE "pharmacy_pack_prices" DROP CONSTRAINT IF EXISTS "pharmacy_pack_prices_source_check";
ALTER TABLE "pharmacy_pack_prices" ADD CONSTRAINT "pharmacy_pack_prices_source_check"
  CHECK ("source" IN ('drap', 'manual', 'supplier', 'import'));

COMMIT;
