CREATE TYPE "PharmacyProductFamily" AS ENUM ('PHARMACEUTICAL','BIOLOGICAL','DEVICE','ALTERNATIVE','FRONT_SHOP');
CREATE TYPE "MedicineProvenanceStatus" AS ENUM ('PENDING','VERIFIED','REJECTED','SUPERSEDED');

CREATE TABLE "pharmacy_ingredients" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "name" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("organizationId", "name")
);
CREATE INDEX "pharmacy_ingredients_organizationId_idx" ON "pharmacy_ingredients"("organizationId");

CREATE TABLE "pharmacy_medicines" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "productName" TEXT NOT NULL, "brandName" TEXT, "manufacturer" TEXT, "marketingAuthorizationHolder" TEXT,
  "drapRegistrationNumber" TEXT, "drapRegistrationStatus" TEXT, "drapRegisteredAt" TIMESTAMP(3),
  "productFamily" "PharmacyProductFamily" NOT NULL, "rx" BOOLEAN NOT NULL DEFAULT false,
  "otc" BOOLEAN NOT NULL DEFAULT false, "restricted" BOOLEAN NOT NULL DEFAULT false,
  "controlled" BOOLEAN NOT NULL DEFAULT false, "highAlert" BOOLEAN NOT NULL DEFAULT false,
  "lasa" BOOLEAN NOT NULL DEFAULT false, "coldChain" BOOLEAN NOT NULL DEFAULT false,
  "saleable" BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "pharmacy_medicines_organizationId_productName_idx" ON "pharmacy_medicines"("organizationId", "productName");

CREATE TABLE "pharmacy_medicine_strength_components" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "medicineId" TEXT NOT NULL REFERENCES "pharmacy_medicines"("id") ON DELETE RESTRICT,
  "ingredientId" TEXT NOT NULL REFERENCES "pharmacy_ingredients"("id") ON DELETE RESTRICT,
  "value" DECIMAL(18,6) NOT NULL CHECK ("value" > 0), "unit" TEXT NOT NULL CHECK (length(btrim("unit")) > 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("medicineId", "ingredientId", "value", "unit")
);
CREATE INDEX "pharmacy_medicine_strength_components_organizationId_medicineId_idx" ON "pharmacy_medicine_strength_components"("organizationId", "medicineId");

CREATE TABLE "pharmacy_presentations" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "medicineId" TEXT NOT NULL REFERENCES "pharmacy_medicines"("id") ON DELETE RESTRICT,
  "dosageForm" TEXT, "route" TEXT, "presentation" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "pharmacy_presentations_organizationId_medicineId_idx" ON "pharmacy_presentations"("organizationId", "medicineId");

CREATE TABLE "pharmacy_pack_levels" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "presentationId" TEXT NOT NULL REFERENCES "pharmacy_presentations"("id") ON DELETE RESTRICT,
  "parentPackLevelId" TEXT REFERENCES "pharmacy_pack_levels"("id") ON DELETE RESTRICT,
  "versionGroupId" TEXT NOT NULL, "version" INTEGER NOT NULL CHECK ("version" > 0),
  "level" TEXT NOT NULL CHECK ("level" IN ('CARTON','BOX','STRIP','UNIT')),
  "unitsPerParent" INTEGER NOT NULL CHECK ("unitsPerParent" > 0),
  "effectiveFrom" TIMESTAMP(3) NOT NULL, "effectiveTo" TIMESTAMP(3), "referencedAt" TIMESTAMP(3),
  "supersedesPackLevelId" TEXT REFERENCES "pharmacy_pack_levels"("id") ON DELETE RESTRICT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "versionGroupId", "version"),
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom"),
  CHECK (("level" = 'CARTON' AND "parentPackLevelId" IS NULL) OR "level" <> 'CARTON')
);
CREATE INDEX "pharmacy_pack_levels_organizationId_presentationId_idx" ON "pharmacy_pack_levels"("organizationId", "presentationId");

CREATE TABLE "pharmacy_medicine_pack_mrps" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "packLevelId" TEXT NOT NULL REFERENCES "pharmacy_pack_levels"("id") ON DELETE RESTRICT,
  "batchReference" TEXT NOT NULL, "printedMrpMinor" INTEGER NOT NULL CHECK ("printedMrpMinor" >= 0),
  "roundingIncrementMinor" INTEGER NOT NULL DEFAULT 1 CHECK ("roundingIncrementMinor" > 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "packLevelId", "batchReference")
);
CREATE INDEX "pharmacy_medicine_pack_mrps_organizationId_batchReference_idx" ON "pharmacy_medicine_pack_mrps"("organizationId", "batchReference");

CREATE TABLE "pharmacy_medicine_provenance" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "medicineId" TEXT NOT NULL REFERENCES "pharmacy_medicines"("id") ON DELETE RESTRICT,
  "field" TEXT NOT NULL, "source" TEXT NOT NULL, "retrievedAt" TIMESTAMP(3) NOT NULL,
  "confidence" DECIMAL(5,4) CHECK ("confidence" BETWEEN 0 AND 1), "reviewer" TEXT,
  "status" "MedicineProvenanceStatus" NOT NULL, "supersedesId" TEXT REFERENCES "pharmacy_medicine_provenance"("id") ON DELETE RESTRICT,
  "assertedValue" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "pharmacy_medicine_provenance_organizationId_medicineId_field_idx" ON "pharmacy_medicine_provenance"("organizationId", "medicineId", "field");

CREATE FUNCTION pharmacy_reject_referenced_pack_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."referencedAt" IS NOT NULL AND
    (NEW."unitsPerParent", NEW."parentPackLevelId", NEW."presentationId", NEW."level", NEW."versionGroupId", NEW."version", NEW."effectiveFrom")
    IS DISTINCT FROM
    (OLD."unitsPerParent", OLD."parentPackLevelId", OLD."presentationId", OLD."level", OLD."versionGroupId", OLD."version", OLD."effectiveFrom") THEN
    RAISE EXCEPTION 'referenced pack conversion is immutable; create a new version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_pack_conversion_immutable BEFORE UPDATE ON "pharmacy_pack_levels"
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_referenced_pack_rewrite();

CREATE FUNCTION pharmacy_validate_pack_hierarchy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_org text; parent_presentation text;
BEGIN
  IF NEW."parentPackLevelId" IS NULL THEN RETURN NEW; END IF;
  SELECT "organizationId", "presentationId" INTO parent_org, parent_presentation
  FROM "pharmacy_pack_levels" WHERE id = NEW."parentPackLevelId";
  IF parent_org IS DISTINCT FROM NEW."organizationId" OR parent_presentation IS DISTINCT FROM NEW."presentationId" THEN
    RAISE EXCEPTION 'pack parent must belong to the same tenant and presentation' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    WITH RECURSIVE ancestors(id, parent_id) AS (
      SELECT id, "parentPackLevelId" FROM "pharmacy_pack_levels" WHERE id = NEW."parentPackLevelId"
      UNION ALL
      SELECT p.id, p."parentPackLevelId" FROM "pharmacy_pack_levels" p JOIN ancestors a ON p.id = a.parent_id
    ) SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'pack hierarchy must be acyclic' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_pack_hierarchy_valid BEFORE INSERT OR UPDATE OF "parentPackLevelId", "presentationId", "organizationId"
ON "pharmacy_pack_levels" FOR EACH ROW EXECUTE FUNCTION pharmacy_validate_pack_hierarchy();

CREATE FUNCTION pharmacy_reject_append_only_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514'; END $$;
CREATE TRIGGER pharmacy_provenance_append_only BEFORE UPDATE OR DELETE ON "pharmacy_medicine_provenance"
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
CREATE TRIGGER pharmacy_mrp_append_only BEFORE UPDATE OR DELETE ON "pharmacy_medicine_pack_mrps"
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['pharmacy_ingredients','pharmacy_medicines','pharmacy_medicine_strength_components','pharmacy_presentations','pharmacy_pack_levels','pharmacy_medicine_pack_mrps','pharmacy_medicine_provenance'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.is_platform_admin'', true) = ''true'' OR "organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''')) WITH CHECK (current_setting(''app.is_platform_admin'', true) = ''true'' OR "organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))', table_name);
  END LOOP;
END $$;
