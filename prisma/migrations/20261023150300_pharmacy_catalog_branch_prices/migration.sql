-- Catalogue preload round 2 (CAT-SEC-03/04): applied catalogue selling and
-- purchase prices, and the "use catalogue default prices" setting, move from
-- organization scope to branch scope. The organization-wide round-1 columns
-- and table were never released and hold no production data.

-- 1. Retire the round-1 guards, which read organization-wide pack prices.
DROP TRIGGER "pharmacy_catalog_pack_price_guard_update" ON "pharmacy_pack_levels";
DROP TRIGGER "pharmacy_catalog_pack_price_guard_delete" ON "pharmacy_pack_levels";
DROP FUNCTION pharmacy_catalog_pack_price_guard();
DROP TRIGGER "pharmacy_catalog_medicine_saleable_guard" ON "pharmacy_medicines";
DROP FUNCTION pharmacy_catalog_medicine_saleable_guard();

-- 2. No organization-wide applied price or setting remains. Dropping the
-- columns also drops the round-1 CHECK that named them; the reference defaults
-- keep their own non-negative CHECK (validated in 20261023150301).
ALTER TABLE "pharmacy_pack_levels" DROP COLUMN "sellingPriceMinor", DROP COLUMN "purchasePriceMinor";
ALTER TABLE "pharmacy_pack_levels" ADD CONSTRAINT "pharmacy_pack_levels_catalog_defaults_ck" CHECK (
  ("catalogDefaultSalePriceMinor" IS NULL OR "catalogDefaultSalePriceMinor" >= 0) AND
  ("catalogDefaultPurchasePriceMinor" IS NULL OR "catalogDefaultPurchasePriceMinor" >= 0)
) NOT VALID;
DROP TABLE "pharmacy_catalog_settings";

-- 3. Branch visibility. The caller is `app.current_user_id`, which withTenantDb
-- sets from the authenticated session: it needs an active assignment to an
-- active branch of the current organization. A writer that has bound
-- `app.current_branch_id` is further confined to that one branch. A session
-- without a user (platform jobs, the backfill) sees and writes no row.
CREATE FUNCTION pharmacy_catalog_branch_visible(row_org TEXT, row_branch TEXT) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT row_org = NULLIF(current_setting('app.current_organization_id', true), '')
     AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
          OR row_branch = current_setting('app.current_branch_id', true))
     AND EXISTS (
       SELECT 1
         FROM "pharmacy_branch_assignments" assignment
         JOIN "pharmacy_branches" branch
           ON branch."organizationId" = assignment."organizationId"
          AND branch."id" = assignment."branchId"
        WHERE assignment."organizationId" = row_org
          AND assignment."branchId" = row_branch
          AND assignment."userId" = NULLIF(current_setting('app.current_user_id', true), '')
          AND assignment."active"
          AND branch."active"
     )
$$;

CREATE TABLE "pharmacy_catalog_branch_settings" (
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "useCatalogDefaultPrices" BOOLEAN NOT NULL DEFAULT false,
  "enabledById" TEXT,
  "enabledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_catalog_branch_settings_pkey" PRIMARY KEY ("organizationId", "branchId"),
  CONSTRAINT "pharmacy_catalog_branch_settings_branch_fkey" FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_catalog_branch_settings_enabled_ck" CHECK (
    ("useCatalogDefaultPrices" AND "enabledById" IS NOT NULL AND "enabledAt" IS NOT NULL) OR
    (NOT "useCatalogDefaultPrices" AND "enabledById" IS NULL AND "enabledAt" IS NULL)
  )
);

CREATE TABLE "pharmacy_catalog_branch_prices" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "medicineId" TEXT NOT NULL,
  "packLevelId" TEXT NOT NULL,
  "sellingPriceMinor" INTEGER,
  "purchasePriceMinor" INTEGER,
  "updatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_catalog_branch_prices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_catalog_branch_prices_branch_pack_key" UNIQUE ("organizationId", "branchId", "packLevelId"),
  CONSTRAINT "pharmacy_catalog_branch_prices_branch_fkey" FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_catalog_branch_prices_medicine_fkey" FOREIGN KEY ("organizationId", "medicineId")
    REFERENCES "pharmacy_medicines"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_catalog_branch_prices_pack_fkey" FOREIGN KEY ("organizationId", "packLevelId")
    REFERENCES "pharmacy_pack_levels"("organizationId", "id") ON DELETE RESTRICT,
  -- A selling price is a positive amount; a purchase price may be zero (free goods).
  CONSTRAINT "pharmacy_catalog_branch_prices_amounts_ck" CHECK (
    ("sellingPriceMinor" IS NULL OR "sellingPriceMinor" > 0) AND
    ("purchasePriceMinor" IS NULL OR "purchasePriceMinor" >= 0)
  )
);
CREATE INDEX "pharmacy_catalog_branch_prices_medicine_idx"
  ON "pharmacy_catalog_branch_prices"("organizationId", "medicineId");

ALTER TABLE "pharmacy_catalog_branch_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_catalog_branch_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "catalog_branch_scope" ON "pharmacy_catalog_branch_settings"
  USING (pharmacy_catalog_branch_visible("organizationId", "branchId"))
  WITH CHECK (pharmacy_catalog_branch_visible("organizationId", "branchId"));
ALTER TABLE "pharmacy_catalog_branch_prices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_catalog_branch_prices" FORCE ROW LEVEL SECURITY;
CREATE POLICY "catalog_branch_scope" ON "pharmacy_catalog_branch_prices"
  USING (pharmacy_catalog_branch_visible("organizationId", "branchId"))
  WITH CHECK (pharmacy_catalog_branch_visible("organizationId", "branchId"));

-- 4. A branch price names a pack of the same catalogue medicine, a selling
-- price names the current (open-ended) pack version, and the identity of a
-- row never changes after insert.
CREATE FUNCTION pharmacy_catalog_branch_price_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner_medicine TEXT;
  origin TEXT;
  pack_current BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."organizationId", NEW."branchId", NEW."medicineId", NEW."packLevelId")
       IS DISTINCT FROM (OLD."organizationId", OLD."branchId", OLD."medicineId", OLD."packLevelId") THEN
    RAISE EXCEPTION 'a catalogue branch price keeps its branch, medicine and pack' USING ERRCODE = '23514';
  END IF;
  SELECT presentation."medicineId", medicine."catalogVersion", pack."effectiveTo" IS NULL
    INTO owner_medicine, origin, pack_current
    FROM "pharmacy_pack_levels" pack
    JOIN "pharmacy_presentations" presentation
      ON presentation."id" = pack."presentationId" AND presentation."organizationId" = pack."organizationId"
    JOIN "pharmacy_medicines" medicine
      ON medicine."id" = presentation."medicineId" AND medicine."organizationId" = presentation."organizationId"
   WHERE pack."id" = NEW."packLevelId" AND pack."organizationId" = NEW."organizationId";
  IF owner_medicine IS DISTINCT FROM NEW."medicineId" OR origin IS NULL THEN
    RAISE EXCEPTION 'a catalogue branch price must name a pack of the same catalogue medicine'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."sellingPriceMinor" IS NOT NULL AND NOT pack_current THEN
    RAISE EXCEPTION 'a catalogue selling price needs the current pack version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "pharmacy_catalog_branch_price_validate"
BEFORE INSERT OR UPDATE ON "pharmacy_catalog_branch_prices"
FOR EACH ROW EXECUTE FUNCTION pharmacy_catalog_branch_price_validate();

-- 5. Organization-wide availability without cross-branch reads. Each pack and
-- each catalogue medicine counts the positive branch selling prices it holds
-- (one per branch and pack). The counts are maintained only by the statement
-- triggers below, one set-based UPDATE per table per statement, medicines
-- first and packs second: the order every catalogue writer already locks in,
-- so a bulk application stays one write per kind and cannot deadlock another
-- writer that keeps the order.
ALTER TABLE "pharmacy_medicines" ADD COLUMN "catalogSellingPriceCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "pharmacy_medicines" ADD CONSTRAINT "pharmacy_medicines_catalog_price_count_ck"
  CHECK ("catalogSellingPriceCount" >= 0) NOT VALID;
ALTER TABLE "pharmacy_pack_levels" ADD COLUMN "catalogSellingPriceCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "pharmacy_pack_levels" ADD CONSTRAINT "pharmacy_pack_levels_catalog_price_count_ck"
  CHECK ("catalogSellingPriceCount" >= 0) NOT VALID;

-- `changes`: one element per (organization, medicine, pack) with its delta.
CREATE FUNCTION pharmacy_catalog_coverage_apply(changes JSONB) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  expected INTEGER;
  updated INTEGER;
BEGIN
  SELECT count(*) INTO expected
    FROM (SELECT c."organizationId", c."medicineId"
            FROM jsonb_to_recordset(changes) AS c("organizationId" TEXT, "medicineId" TEXT, "packLevelId" TEXT, delta INTEGER)
           GROUP BY 1, 2 HAVING sum(c.delta) <> 0) m;
  IF expected > 0 THEN
    UPDATE "pharmacy_medicines" medicine
       SET "catalogSellingPriceCount" = medicine."catalogSellingPriceCount" + m.delta
      FROM (SELECT c."organizationId", c."medicineId", sum(c.delta)::int AS delta
              FROM jsonb_to_recordset(changes) AS c("organizationId" TEXT, "medicineId" TEXT, "packLevelId" TEXT, delta INTEGER)
             GROUP BY 1, 2 HAVING sum(c.delta) <> 0) m
     WHERE medicine."id" = m."medicineId" AND medicine."organizationId" = m."organizationId";
    GET DIAGNOSTICS updated = ROW_COUNT;
    IF updated <> expected THEN
      RAISE EXCEPTION 'catalogue price coverage could not be updated for every medicine' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT count(*) INTO expected
    FROM jsonb_to_recordset(changes) AS c("organizationId" TEXT, "medicineId" TEXT, "packLevelId" TEXT, delta INTEGER)
   WHERE c.delta <> 0;
  IF expected > 0 THEN
    UPDATE "pharmacy_pack_levels" pack
       SET "catalogSellingPriceCount" = pack."catalogSellingPriceCount" + c.delta
      FROM jsonb_to_recordset(changes) AS c("organizationId" TEXT, "medicineId" TEXT, "packLevelId" TEXT, delta INTEGER)
     WHERE pack."id" = c."packLevelId" AND pack."organizationId" = c."organizationId" AND c.delta <> 0;
    GET DIAGNOSTICS updated = ROW_COUNT;
    IF updated <> expected THEN
      RAISE EXCEPTION 'catalogue price coverage could not be updated for every pack' USING ERRCODE = '23514';
    END IF;
  END IF;
END $$;

CREATE FUNCTION pharmacy_catalog_coverage_after_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pharmacy_catalog_coverage_apply((
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'organizationId', n."organizationId", 'medicineId', n."medicineId",
             'packLevelId', n."packLevelId", 'delta', n.delta)), '[]'::jsonb)
      FROM (SELECT "organizationId", "medicineId", "packLevelId", count(*)::int AS delta
              FROM inserted WHERE "sellingPriceMinor" > 0 GROUP BY 1, 2, 3) n));
  RETURN NULL;
END $$;
CREATE FUNCTION pharmacy_catalog_coverage_after_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pharmacy_catalog_coverage_apply((
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'organizationId', d."organizationId", 'medicineId', d."medicineId",
             'packLevelId', d."packLevelId", 'delta', d.delta)), '[]'::jsonb)
      FROM (SELECT a."organizationId", a."medicineId", a."packLevelId",
                   (count(*) FILTER (WHERE a."sellingPriceMinor" > 0)
                    - count(*) FILTER (WHERE b."sellingPriceMinor" > 0))::int AS delta
              FROM after_rows a JOIN before_rows b ON b."id" = a."id"
             GROUP BY 1, 2, 3) d));
  RETURN NULL;
END $$;
CREATE FUNCTION pharmacy_catalog_coverage_after_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pharmacy_catalog_coverage_apply((
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'organizationId', r."organizationId", 'medicineId', r."medicineId",
             'packLevelId', r."packLevelId", 'delta', -r.removed)), '[]'::jsonb)
      FROM (SELECT "organizationId", "medicineId", "packLevelId", count(*)::int AS removed
              FROM removed_rows WHERE "sellingPriceMinor" > 0 GROUP BY 1, 2, 3) r));
  RETURN NULL;
END $$;
CREATE TRIGGER "pharmacy_catalog_coverage_insert" AFTER INSERT ON "pharmacy_catalog_branch_prices"
  REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION pharmacy_catalog_coverage_after_insert();
CREATE TRIGGER "pharmacy_catalog_coverage_update" AFTER UPDATE ON "pharmacy_catalog_branch_prices"
  REFERENCING OLD TABLE AS before_rows NEW TABLE AS after_rows FOR EACH STATEMENT EXECUTE FUNCTION pharmacy_catalog_coverage_after_update();
CREATE TRIGGER "pharmacy_catalog_coverage_delete" AFTER DELETE ON "pharmacy_catalog_branch_prices"
  REFERENCING OLD TABLE AS removed_rows FOR EACH STATEMENT EXECUTE FUNCTION pharmacy_catalog_coverage_after_delete();

-- 6. The medicine guard. Catalogue medicines start unsaleable with no
-- coverage; the origin is immutable; the count changes only from inside the
-- price triggers; and a saleable catalogue medicine always holds a positive
-- selling price in at least one branch, in both directions (making it
-- saleable, and removing the last such price while it is saleable).
CREATE FUNCTION pharmacy_catalog_medicine_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."catalogSellingPriceCount" <> 0 THEN
      RAISE EXCEPTION 'catalogue price coverage is maintained by the database' USING ERRCODE = '23514';
    END IF;
    IF NEW."catalogVersion" IS NOT NULL AND NEW."saleable" THEN
      RAISE EXCEPTION 'catalogue medicines must be created unsaleable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."catalogVersion" IS DISTINCT FROM OLD."catalogVersion" THEN
    RAISE EXCEPTION 'the catalogue origin of a medicine is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."catalogSellingPriceCount" IS DISTINCT FROM OLD."catalogSellingPriceCount" AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'catalogue price coverage is maintained by the database' USING ERRCODE = '23514';
  END IF;
  IF NEW."catalogVersion" IS NOT NULL AND NEW."saleable" AND NEW."catalogSellingPriceCount" <= 0 THEN
    RAISE EXCEPTION 'a saleable catalogue medicine needs a positive selling price in at least one branch; make it unavailable first'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "pharmacy_catalog_medicine_guard"
BEFORE INSERT OR UPDATE OF "saleable", "catalogVersion", "catalogSellingPriceCount" ON "pharmacy_medicines"
FOR EACH ROW EXECUTE FUNCTION pharmacy_catalog_medicine_guard();

-- 7. The pack guard keeps every counted price on a current pack of its
-- medicine: the count changes only from inside the price triggers, never on a
-- superseded pack, and a pack that holds branch selling prices is neither
-- superseded nor moved until those prices are removed.
CREATE FUNCTION pharmacy_catalog_pack_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."catalogSellingPriceCount" <> 0 THEN
      RAISE EXCEPTION 'catalogue price coverage is maintained by the database' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."catalogSellingPriceCount" IS DISTINCT FROM OLD."catalogSellingPriceCount" AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'catalogue price coverage is maintained by the database' USING ERRCODE = '23514';
  END IF;
  IF NEW."catalogSellingPriceCount" > OLD."catalogSellingPriceCount" AND NEW."effectiveTo" IS NOT NULL THEN
    RAISE EXCEPTION 'a catalogue selling price needs the current pack version' USING ERRCODE = '23514';
  END IF;
  IF OLD."catalogSellingPriceCount" > 0 AND (
       (OLD."effectiveTo" IS NULL AND NEW."effectiveTo" IS NOT NULL)
       OR (NEW."presentationId", NEW."organizationId") IS DISTINCT FROM (OLD."presentationId", OLD."organizationId")
     ) THEN
    RAISE EXCEPTION 'a pack with catalogue branch selling prices cannot be superseded or moved; remove those prices first'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "pharmacy_catalog_pack_guard"
BEFORE INSERT OR UPDATE OF "catalogSellingPriceCount", "effectiveTo", "presentationId", "organizationId" ON "pharmacy_pack_levels"
FOR EACH ROW EXECUTE FUNCTION pharmacy_catalog_pack_guard();

-- A presentation whose packs hold branch selling prices keeps its medicine.
-- The pack rows are locked first, so a concurrent first price either commits
-- before this check (and is seen) or waits for this transaction.
CREATE FUNCTION pharmacy_catalog_presentation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."medicineId", NEW."organizationId") IS NOT DISTINCT FROM (OLD."medicineId", OLD."organizationId") THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM "pharmacy_pack_levels" pack
    WHERE pack."presentationId" = OLD."id" AND pack."organizationId" = OLD."organizationId"
    FOR SHARE;
  IF EXISTS (SELECT 1 FROM "pharmacy_pack_levels" pack
              WHERE pack."presentationId" = OLD."id" AND pack."organizationId" = OLD."organizationId"
                AND pack."catalogSellingPriceCount" > 0) THEN
    RAISE EXCEPTION 'a presentation with catalogue branch selling prices keeps its medicine'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "pharmacy_catalog_presentation_guard"
BEFORE UPDATE OF "medicineId", "organizationId" ON "pharmacy_presentations"
FOR EACH ROW EXECUTE FUNCTION pharmacy_catalog_presentation_guard();
