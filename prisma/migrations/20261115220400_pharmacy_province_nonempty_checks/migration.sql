-- DEV-235 (#467): recovered from archive/fix/qa-129-lows.
--
-- A branch operates under its own province's jurisdiction rules, and the
-- regulatory-profile save and operation guard compare the profile's province
-- with the branch's. An empty province can never name a jurisdiction, so it must
-- never be newly stored on either side. The application already refuses one;
-- this migration makes the database refuse it too.
--
-- Branches: 20260902160000_pharmacy_onboarding_and_branch backfilled legacy
-- branches with provinceCode = ''. A CHECK (even NOT VALID) is enforced on every
-- later UPDATE of such a row, so unrelated saves (receipt format, payment
-- settings) would start failing. A trigger instead refuses a blank province only
-- when a branch is inserted or its province is changed, which leaves unrelated
-- updates to legacy rows working until an operator sets their province.
--
-- Regulatory profiles: rows are append-only and every profile has been written
-- with a required province, so a NOT VALID CHECK is safe there and never
-- rewrites or re-scans history.
--
-- Idempotent: the function is replaced, the trigger recreated, and the CHECK
-- added only when missing.
BEGIN;

CREATE OR REPLACE FUNCTION pharmacy_branch_province_nonempty() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF btrim(coalesce(NEW."provinceCode", '')) = ''
     AND (TG_OP = 'INSERT' OR NEW."provinceCode" IS DISTINCT FROM OLD."provinceCode") THEN
    RAISE EXCEPTION 'pharmacy_branches.provinceCode must name a province'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "pharmacy_branches_province_nonempty" ON "pharmacy_branches";
CREATE TRIGGER "pharmacy_branches_province_nonempty"
  BEFORE INSERT OR UPDATE OF "provinceCode" ON "pharmacy_branches"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_branch_province_nonempty();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pharmacy_branch_regulatory_profiles_province_nonempty'
       AND conrelid = '"pharmacy_branch_regulatory_profiles"'::regclass
  ) THEN
    ALTER TABLE "pharmacy_branch_regulatory_profiles"
      ADD CONSTRAINT "pharmacy_branch_regulatory_profiles_province_nonempty"
      CHECK (btrim("provinceCode") <> '') NOT VALID;
  END IF;
END $$;

COMMIT;
