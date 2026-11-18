-- DEV-846 (DEV-86): the owner records pharmacist coverage hours per branch.
-- Additive columns on the existing RLS-protected pharmacy_branches table; its
-- tenant isolation policies are unchanged. These hours are a record only: the
-- live-sale hours check still reads the jurisdiction rule set and stays off
-- until the pharmacist adviser's provincial rules are published there.
BEGIN;

ALTER TABLE pharmacy_branches
  ADD COLUMN IF NOT EXISTS "pharmacistCoverageHours" JSONB,
  ADD COLUMN IF NOT EXISTS "pharmacistCoverageRevision" INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pharmacy_branch_pharmacist_coverage_hours_check'
      AND conrelid = 'pharmacy_branches'::regclass
  ) THEN
    ALTER TABLE pharmacy_branches
      ADD CONSTRAINT pharmacy_branch_pharmacist_coverage_hours_check CHECK (
        "pharmacistCoverageRevision" >= 0
        AND (
          "pharmacistCoverageHours" IS NULL
          OR (
            jsonb_typeof("pharmacistCoverageHours") = 'object'
            AND jsonb_typeof("pharmacistCoverageHours" -> 'windows') = 'array'
          )
        )
      );
  END IF;
END $$;

COMMIT;
