-- Catalogue preload hold fix: catalogue medicines start unsaleable, and only an
-- explicit change with a valid price can make one saleable. Enforced here so it
-- holds for every writer (onboarding job, platform backfill, routers, scripts).

-- Origin marker. Written only by the bundled-catalogue seed; immutable afterwards.
ALTER TABLE "pharmacy_medicines" ADD COLUMN "catalogVersion" TEXT;
ALTER TABLE "pharmacy_medicines" ADD CONSTRAINT "pharmacy_medicines_catalog_version_ck"
  CHECK ("catalogVersion" IS NULL OR char_length("catalogVersion") BETWEEN 1 AND 64);

-- A "valid price" is a positive tenant selling price on an open (current) pack
-- version. Time is deliberately not part of the rule, so a medicine cannot drift
-- out of compliance without a write.
CREATE FUNCTION pharmacy_catalog_medicine_saleable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."catalogVersion" IS DISTINCT FROM OLD."catalogVersion" THEN
    RAISE EXCEPTION 'the catalogue origin of a medicine is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."catalogVersion" IS NULL OR NOT NEW."saleable" THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'catalogue medicines must be created unsaleable' USING ERRCODE = '23514';
  END IF;
  IF OLD."saleable" THEN
    RETURN NEW;
  END IF;
  -- Unsaleable -> saleable. The priced pack rows are locked FOR SHARE, so a
  -- concurrent price removal either commits first (and is seen here, through
  -- READ COMMITTED's re-check of the locked row) or waits for this transaction.
  PERFORM 1
    FROM "pharmacy_pack_levels" pack
    JOIN "pharmacy_presentations" presentation ON presentation."id" = pack."presentationId"
   WHERE presentation."medicineId" = NEW."id"
     AND presentation."organizationId" = NEW."organizationId"
     AND pack."organizationId" = NEW."organizationId"
     AND pack."effectiveTo" IS NULL
     AND pack."sellingPriceMinor" > 0
     FOR SHARE OF pack;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a catalogue medicine needs a positive selling price on its current pack before it can be saleable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER pharmacy_catalog_medicine_saleable_guard
BEFORE INSERT OR UPDATE OF "saleable", "catalogVersion" ON "pharmacy_medicines"
FOR EACH ROW EXECUTE FUNCTION pharmacy_catalog_medicine_saleable_guard();

-- The other direction: no write may leave a saleable catalogue medicine without
-- a valid price (clearing it, closing its pack version, moving or deleting it).
-- Checked at commit so a writer may replace a priced version within one
-- transaction. The medicine row is locked first, the same order the application
-- writers use, so two concurrent removals on one medicine cannot both pass.
CREATE FUNCTION pharmacy_catalog_pack_price_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  medicine_id TEXT;
BEGIN
  SELECT presentation."medicineId" INTO medicine_id
    FROM "pharmacy_presentations" presentation
   WHERE presentation."id" = OLD."presentationId";
  PERFORM 1
    FROM "pharmacy_medicines" medicine
   WHERE medicine."id" = medicine_id
     AND medicine."saleable"
     AND medicine."catalogVersion" IS NOT NULL
     FOR NO KEY UPDATE OF medicine;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM "pharmacy_pack_levels" pack
      JOIN "pharmacy_presentations" presentation ON presentation."id" = pack."presentationId"
     WHERE presentation."medicineId" = medicine_id
       AND pack."effectiveTo" IS NULL
       AND pack."sellingPriceMinor" > 0
  ) THEN
    RAISE EXCEPTION 'a saleable catalogue medicine must keep a positive selling price on its current pack; make it unavailable first'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

-- WHEN keeps bulk default-price application (NULL -> price) free of this check.
CREATE CONSTRAINT TRIGGER pharmacy_catalog_pack_price_guard_update
AFTER UPDATE OF "sellingPriceMinor", "effectiveTo", "presentationId" ON "pharmacy_pack_levels"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  OLD."effectiveTo" IS NULL AND OLD."sellingPriceMinor" > 0 AND (
    NEW."effectiveTo" IS NOT NULL
    OR NEW."sellingPriceMinor" IS NULL
    OR NEW."sellingPriceMinor" <= 0
    OR NEW."presentationId" IS DISTINCT FROM OLD."presentationId"
  )
)
EXECUTE FUNCTION pharmacy_catalog_pack_price_guard();

CREATE CONSTRAINT TRIGGER pharmacy_catalog_pack_price_guard_delete
AFTER DELETE ON "pharmacy_pack_levels"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."effectiveTo" IS NULL AND OLD."sellingPriceMinor" > 0)
EXECUTE FUNCTION pharmacy_catalog_pack_price_guard();
