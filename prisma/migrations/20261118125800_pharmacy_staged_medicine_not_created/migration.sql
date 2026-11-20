BEGIN;

-- DEV-1002: a staged product row the database refuses to store as a medicine (for example a
-- cell the catalogue cannot hold) no longer stops the other rows of its group. The row is
-- recorded on its link as NOT_CREATED, with no medicine and a plain reason for the person who
-- imported it; every other row of the group is created. The link stays read-and-insert only
-- (row-level security forced since 20261118122600): a NOT_CREATED row is evidence, never
-- changed into a medicine later; a corrected file is staged again and matched by old code or
-- name and pack, so nothing already created is made twice.
ALTER TABLE "pharmacy_staged_medicine_links"
  ALTER COLUMN "medicineId" DROP NOT NULL;
ALTER TABLE "pharmacy_staged_medicine_links"
  ADD COLUMN IF NOT EXISTS "notCreatedReason" TEXT;
-- An old code or generic name the catalogue cannot search (its characters normalise to nothing
-- in the database, such as "½" or "①") is left off the medicine and reported here, as a
-- barcode that was not added is.
ALTER TABLE "pharmacy_staged_medicine_links"
  ADD COLUMN IF NOT EXISTS "aliasesNotAdded" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "pharmacy_staged_medicine_links"
  DROP CONSTRAINT IF EXISTS "pharmacy_staged_medicine_links_aliases_not_added_check";
ALTER TABLE "pharmacy_staged_medicine_links"
  ADD CONSTRAINT "pharmacy_staged_medicine_links_aliases_not_added_check"
  CHECK (cardinality("aliasesNotAdded") <= 2);

ALTER TABLE "pharmacy_staged_medicine_links"
  DROP CONSTRAINT IF EXISTS "pharmacy_staged_medicine_links_outcome_check";
ALTER TABLE "pharmacy_staged_medicine_links"
  ADD CONSTRAINT "pharmacy_staged_medicine_links_outcome_check"
  CHECK ("outcome" IN ('CREATED', 'MATCHED', 'NOT_CREATED'));

-- A medicine exactly when the row became one; a reason exactly when it did not.
ALTER TABLE "pharmacy_staged_medicine_links"
  DROP CONSTRAINT IF EXISTS "pharmacy_staged_medicine_links_not_created_check";
ALTER TABLE "pharmacy_staged_medicine_links"
  ADD CONSTRAINT "pharmacy_staged_medicine_links_not_created_check"
  CHECK (
    ("outcome" = 'NOT_CREATED') = ("medicineId" IS NULL)
    AND ("outcome" = 'NOT_CREATED') = ("notCreatedReason" IS NOT NULL)
    AND (
      "notCreatedReason" IS NULL
      OR (btrim("notCreatedReason") <> '' AND char_length("notCreatedReason") <= 500)
    )
    AND ("outcome" <> 'NOT_CREATED' OR ("packLevelId" IS NULL AND "matchKey" IS NULL))
  );

COMMIT;
