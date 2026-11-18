-- DEV-73: a prescription-only refill cycle is held until a valid prescription
-- covers that cycle AND a pharmacist signs it with a fresh PIN. The approval now
-- records the prescription line it relied on, and the CHECK below refuses a
-- prescription-only cycle that left AWAITING_PHARMACIST without one. There is no
-- emergency exception. Cycles approved before this rule without a prescription
-- that have not reached the counter go back to AWAITING_PHARMACIST.
-- Idempotent: safe to re-run.
BEGIN;

-- The tables force RLS, including for their owner. Keep administrative scope
-- local to this transaction so the re-hold reaches every tenant's cycles.
SELECT set_config('app.is_platform_admin', 'true', true);

ALTER TABLE "pharmacy_refill_subscription_cycles" ADD COLUMN IF NOT EXISTS "prescriptionLineId" TEXT;

DO $$ BEGIN
  ALTER TABLE "pharmacy_refill_subscription_cycles" ADD CONSTRAINT "pharmacy_refill_subscription_cycles_prescription_line_fkey" FOREIGN KEY ("organizationId", "prescriptionLineId") REFERENCES "pharmacy_prescription_lines"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The platform-admin policy only reads across tenants; an UPDATE still needs
-- the row's organization and branch, so re-hold one tenant branch at a time.
DO $$
DECLARE
  target RECORD;
BEGIN
  FOR target IN
    SELECT DISTINCT "organizationId", "branchId"
    FROM "pharmacy_refill_subscription_cycles"
    WHERE "requiresPharmacist"
      AND "status" = 'RESERVED'
      AND "prescriptionLineId" IS NULL
    ORDER BY "organizationId", "branchId"
  LOOP
    PERFORM set_config('app.current_organization_id', target."organizationId", true);
    PERFORM set_config('app.current_branch_id', target."branchId", true);
    UPDATE "pharmacy_refill_subscription_cycles"
    SET "status" = 'AWAITING_PHARMACIST'
    WHERE "organizationId" = target."organizationId"
      AND "branchId" = target."branchId"
      AND "requiresPharmacist"
      AND "status" = 'RESERVED'
      AND "prescriptionLineId" IS NULL;
  END LOOP;
  PERFORM set_config('app.current_organization_id', '', true);
  PERFORM set_config('app.current_branch_id', '', true);
END $$;

-- NOT VALID: a legacy cycle already handed to the counter keeps its history; the
-- counter sale itself still needs a prescription before it can complete.
DO $$ BEGIN
  ALTER TABLE "pharmacy_refill_subscription_cycles" ADD CONSTRAINT "pharmacy_refill_cycles_rx_prescription_ck" CHECK (
    NOT "requiresPharmacist"
    OR "status" IN ('AWAITING_PHARMACIST', 'RELEASED')
    OR "prescriptionLineId" IS NOT NULL
  ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "pharmacy_refill_subscription_cycles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_refill_subscription_cycles" FORCE ROW LEVEL SECURITY;

COMMIT;
