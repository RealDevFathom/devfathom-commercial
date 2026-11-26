BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "pharmacy_branches"
  ADD COLUMN IF NOT EXISTS "requireSecondPharmacist" BOOLEAN NOT NULL DEFAULT false;

-- A legacy business-wide check-off marker can never override a branch countersign.
CREATE OR REPLACE FUNCTION pharmacy_require_branch_countersign() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pharmacy_branches b
     WHERE b."organizationId"=NEW."organizationId" AND b.id=NEW."branchId"
       AND b.active AND NOT b."requireSecondPharmacist"
     FOR SHARE OF b
  ) THEN RAISE EXCEPTION 'branch requires a controlled medicine countersign' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pharmacy_require_branch_countersign ON pharmacy_controlled_register_entries;
CREATE TRIGGER pharmacy_require_branch_countersign BEFORE INSERT ON pharmacy_controlled_register_entries
  FOR EACH ROW WHEN (NEW."signatureRef" LIKE 'pharmacist-check-off:%')
  EXECUTE FUNCTION pharmacy_require_branch_countersign();

COMMIT;
