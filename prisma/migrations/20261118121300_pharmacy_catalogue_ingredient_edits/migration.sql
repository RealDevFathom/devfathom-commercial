BEGIN;

-- DEV-19: a new ingredient belongs to no medicine yet, so its queued catalogue
-- edit carries no medicine. Every other operation still names its medicine.
ALTER TABLE "pharmacy_catalogue_edits" ALTER COLUMN "medicineId" DROP NOT NULL;
ALTER TABLE "pharmacy_catalogue_edits"
  DROP CONSTRAINT IF EXISTS "pharmacy_catalogue_edits_medicine_scope_check";
ALTER TABLE "pharmacy_catalogue_edits"
  ADD CONSTRAINT "pharmacy_catalogue_edits_medicine_scope_check"
  CHECK (("operation" = 'createIngredient') = ("medicineId" IS NULL));

COMMIT;
