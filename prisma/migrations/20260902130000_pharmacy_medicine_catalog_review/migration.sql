CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE "MedicineProvenanceSourceType" AS ENUM ('REGULATOR','MANUFACTURER','SCRAPED','USER','IMPORT');
CREATE TYPE "MedicineBarcodeType" AS ENUM ('GTIN','MANUFACTURER','INTERNAL');
CREATE TYPE "MedicineAliasType" AS ENUM ('BRAND','GENERIC','URDU','TRANSLITERATION','LEGACY_CODE');
CREATE TYPE "MedicineReviewAction" AS ENUM ('ACCEPT','CORRECT','SPLIT','MERGE','REJECT','DEFER');
CREATE TYPE "MedicinePublicationBatchStatus" AS ENUM ('DRAFT','PUBLISHED','SUPERSEDED');

ALTER TYPE "MedicineProvenanceStatus" RENAME TO "MedicineProvenanceStatus_old";
CREATE TYPE "MedicineProvenanceStatus" AS ENUM ('UNREVIEWED','ACCEPTED','CORRECTED','REJECTED','SUPERSEDED');
ALTER TABLE "pharmacy_medicine_provenance"
  ALTER COLUMN "status" TYPE "MedicineProvenanceStatus"
  USING (CASE "status"::text
    WHEN 'PENDING' THEN 'UNREVIEWED'
    WHEN 'VERIFIED' THEN 'ACCEPTED'
    ELSE "status"::text
  END)::"MedicineProvenanceStatus";
DROP TYPE "MedicineProvenanceStatus_old";
ALTER TABLE "pharmacy_medicine_provenance"
  ADD COLUMN "sourceType" "MedicineProvenanceSourceType" NOT NULL DEFAULT 'USER';
ALTER TABLE "pharmacy_medicine_provenance" ALTER COLUMN "sourceType" DROP DEFAULT;

CREATE TABLE "pharmacy_medicine_barcodes" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "presentationId" TEXT NOT NULL REFERENCES "pharmacy_presentations"("id") ON DELETE RESTRICT,
  "packLevelId" TEXT REFERENCES "pharmacy_pack_levels"("id") ON DELETE RESTRICT,
  "type" "MedicineBarcodeType" NOT NULL,
  "code" TEXT NOT NULL CHECK (length(btrim("code")) > 0),
  "normalizedCode" TEXT NOT NULL CHECK (length("normalizedCode") > 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "normalizedCode")
);
CREATE INDEX "pharmacy_medicine_barcodes_organizationId_presentationId_idx"
  ON "pharmacy_medicine_barcodes"("organizationId", "presentationId");

CREATE TABLE "pharmacy_medicine_aliases" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "medicineId" TEXT NOT NULL REFERENCES "pharmacy_medicines"("id") ON DELETE RESTRICT,
  "type" "MedicineAliasType" NOT NULL,
  "value" TEXT NOT NULL CHECK (length(btrim("value")) > 0),
  "normalizedValue" TEXT NOT NULL CHECK (length("normalizedValue") > 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "medicineId", "type", "normalizedValue")
);
CREATE INDEX "pharmacy_medicine_aliases_organizationId_normalizedValue_idx"
  ON "pharmacy_medicine_aliases"("organizationId", "normalizedValue");
CREATE INDEX "pharmacy_medicine_aliases_value_trgm_idx"
  ON "pharmacy_medicine_aliases" USING GIN ("normalizedValue" gin_trgm_ops);

CREATE TABLE "pharmacy_medicine_review_decisions" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "duplicateKey" TEXT NOT NULL,
  "action" "MedicineReviewAction" NOT NULL,
  "medicineIds" TEXT[] NOT NULL,
  "payload" JSONB,
  "reviewerId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "pharmacy_medicine_review_decisions_org_key_created_idx"
  ON "pharmacy_medicine_review_decisions"("organizationId", "duplicateKey", "createdAt");

CREATE TABLE "pharmacy_medicine_publication_batches" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "status" "MedicinePublicationBatchStatus" NOT NULL DEFAULT 'DRAFT',
  "publishedBy" TEXT,
  "publishedAt" TIMESTAMP(3),
  "supersedesId" TEXT REFERENCES "pharmacy_medicine_publication_batches"("id") ON DELETE RESTRICT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "pharmacy_medicine_publication_batches_org_created_idx"
  ON "pharmacy_medicine_publication_batches"("organizationId", "createdAt");

CREATE TABLE "pharmacy_medicine_publication_entries" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "batchId" TEXT NOT NULL REFERENCES "pharmacy_medicine_publication_batches"("id") ON DELETE RESTRICT,
  "assertionId" TEXT NOT NULL REFERENCES "pharmacy_medicine_provenance"("id") ON DELETE RESTRICT,
  "priorAssertionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "batchId", "assertionId")
);
CREATE INDEX "pharmacy_medicine_publication_entries_org_batch_idx"
  ON "pharmacy_medicine_publication_entries"("organizationId", "batchId");

CREATE INDEX "pharmacy_medicines_catalog_trgm_idx" ON "pharmacy_medicines" USING GIN
  ((coalesce("productName",'') || ' ' || coalesce("brandName",'')) gin_trgm_ops);
CREATE INDEX "pharmacy_presentations_form_trgm_idx" ON "pharmacy_presentations" USING GIN
  ((coalesce("dosageForm",'') || ' ' || "presentation") gin_trgm_ops);
CREATE INDEX "pharmacy_ingredients_name_trgm_idx" ON "pharmacy_ingredients" USING GIN ("name" gin_trgm_ops);

CREATE FUNCTION pharmacy_normalize_catalog_text(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT regexp_replace(lower(btrim(value)), '[^[:alnum:]]+', '', 'g')
$$;

CREATE FUNCTION pharmacy_validate_barcode_target() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pack_presentation text; target_org text;
BEGIN
  SELECT "organizationId" INTO target_org FROM "pharmacy_presentations" WHERE id = NEW."presentationId";
  IF target_org IS DISTINCT FROM NEW."organizationId" THEN
    RAISE EXCEPTION 'barcode presentation must belong to the same tenant' USING ERRCODE = '23514';
  END IF;
  IF NEW."packLevelId" IS NOT NULL THEN
    SELECT "presentationId" INTO pack_presentation FROM "pharmacy_pack_levels" WHERE id = NEW."packLevelId";
    IF pack_presentation IS DISTINCT FROM NEW."presentationId" THEN
      RAISE EXCEPTION 'barcode pack level must belong to its presentation' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."normalizedCode" IS DISTINCT FROM pharmacy_normalize_catalog_text(NEW."code") THEN
    RAISE EXCEPTION 'normalized barcode does not match code' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_barcode_target_valid BEFORE INSERT ON "pharmacy_medicine_barcodes"
FOR EACH ROW EXECUTE FUNCTION pharmacy_validate_barcode_target();

CREATE FUNCTION pharmacy_validate_alias() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_org text;
BEGIN
  SELECT "organizationId" INTO target_org FROM "pharmacy_medicines" WHERE id = NEW."medicineId";
  IF target_org IS DISTINCT FROM NEW."organizationId" THEN
    RAISE EXCEPTION 'alias medicine must belong to the same tenant' USING ERRCODE = '23514';
  END IF;
  IF NEW."normalizedValue" IS DISTINCT FROM pharmacy_normalize_catalog_text(NEW."value") THEN
    RAISE EXCEPTION 'normalized alias does not match value' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_alias_valid BEFORE INSERT ON "pharmacy_medicine_aliases"
FOR EACH ROW EXECUTE FUNCTION pharmacy_validate_alias();

CREATE FUNCTION pharmacy_validate_provenance_supersession() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior record; medicine_org text;
BEGIN
  SELECT "organizationId" INTO medicine_org FROM "pharmacy_medicines" WHERE id = NEW."medicineId";
  IF medicine_org IS DISTINCT FROM NEW."organizationId" THEN
    RAISE EXCEPTION 'assertion medicine must belong to the same tenant' USING ERRCODE = '23514';
  END IF;
  IF NEW."supersedesId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO prior FROM "pharmacy_medicine_provenance" WHERE id = NEW."supersedesId";
  IF prior.id IS NULL OR prior."organizationId" IS DISTINCT FROM NEW."organizationId"
    OR prior."medicineId" IS DISTINCT FROM NEW."medicineId" OR prior.field IS DISTINCT FROM NEW.field THEN
    RAISE EXCEPTION 'superseded assertion must match tenant, medicine, and field' USING ERRCODE = '23514';
  END IF;
  IF prior.status IN ('ACCEPTED','CORRECTED')
    AND prior."sourceType" IN ('REGULATOR','MANUFACTURER')
    AND NEW."sourceType" IN ('SCRAPED','USER','IMPORT') THEN
    RAISE EXCEPTION 'unverified source cannot replace a verified assertion' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_provenance_supersession_valid BEFORE INSERT ON "pharmacy_medicine_provenance"
FOR EACH ROW EXECUTE FUNCTION pharmacy_validate_provenance_supersession();

CREATE FUNCTION pharmacy_validate_review_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE medicine_id text; medicine_org text;
BEGIN
  FOREACH medicine_id IN ARRAY NEW."medicineIds" LOOP
    SELECT "organizationId" INTO medicine_org FROM "pharmacy_medicines" WHERE id = medicine_id;
    IF medicine_org IS DISTINCT FROM NEW."organizationId" THEN
      RAISE EXCEPTION 'review candidate must belong to the same tenant' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_review_decision_valid BEFORE INSERT ON "pharmacy_medicine_review_decisions"
FOR EACH ROW EXECUTE FUNCTION pharmacy_validate_review_decision();

CREATE FUNCTION pharmacy_validate_publication_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior_org text;
BEGIN
  IF NEW."supersedesId" IS NULL THEN RETURN NEW; END IF;
  SELECT "organizationId" INTO prior_org FROM "pharmacy_medicine_publication_batches" WHERE id = NEW."supersedesId";
  IF prior_org IS DISTINCT FROM NEW."organizationId" THEN
    RAISE EXCEPTION 'superseded publication batch must belong to the same tenant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_publication_batch_valid BEFORE INSERT ON "pharmacy_medicine_publication_batches"
FOR EACH ROW EXECUTE FUNCTION pharmacy_validate_publication_batch();

CREATE FUNCTION pharmacy_validate_publication_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch_org text; assertion_org text; prior_org text;
BEGIN
  SELECT "organizationId" INTO batch_org FROM "pharmacy_medicine_publication_batches" WHERE id = NEW."batchId";
  SELECT "organizationId" INTO assertion_org FROM "pharmacy_medicine_provenance" WHERE id = NEW."assertionId";
  IF NEW."priorAssertionId" IS NOT NULL THEN
    SELECT "organizationId" INTO prior_org FROM "pharmacy_medicine_provenance" WHERE id = NEW."priorAssertionId";
  END IF;
  IF batch_org IS DISTINCT FROM NEW."organizationId" OR assertion_org IS DISTINCT FROM NEW."organizationId"
    OR (NEW."priorAssertionId" IS NOT NULL AND prior_org IS DISTINCT FROM NEW."organizationId") THEN
    RAISE EXCEPTION 'publication references must belong to the same tenant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_publication_entry_valid BEFORE INSERT ON "pharmacy_medicine_publication_entries"
FOR EACH ROW EXECUTE FUNCTION pharmacy_validate_publication_entry();

CREATE TRIGGER pharmacy_barcodes_append_only BEFORE UPDATE OR DELETE ON "pharmacy_medicine_barcodes"
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
CREATE TRIGGER pharmacy_aliases_append_only BEFORE UPDATE OR DELETE ON "pharmacy_medicine_aliases"
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
CREATE TRIGGER pharmacy_review_decisions_append_only BEFORE UPDATE OR DELETE ON "pharmacy_medicine_review_decisions"
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
CREATE TRIGGER pharmacy_publication_entries_append_only BEFORE UPDATE OR DELETE ON "pharmacy_medicine_publication_entries"
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'pharmacy_medicine_barcodes','pharmacy_medicine_aliases','pharmacy_medicine_review_decisions',
    'pharmacy_medicine_publication_batches','pharmacy_medicine_publication_entries'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.is_platform_admin'', true) = ''true'' OR "organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''')) WITH CHECK (current_setting(''app.is_platform_admin'', true) = ''true'' OR "organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))', table_name);
  END LOOP;
END $$;
