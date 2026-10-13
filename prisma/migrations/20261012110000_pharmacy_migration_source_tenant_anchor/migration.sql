-- Proposed additive tenant anchor; execution requires separate review/admission.
-- Existing immutable evidence is never repaired or removed. ADD CONSTRAINT
-- validates every existing row, including rows hidden by RLS; any orphan aborts.
-- RESTRICT prevents organization deletion/ID changes from mutating evidence.
-- Bounded lock acquisition/validation; timeout aborts the whole transaction.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE "public"."pharmacy_migration_sources"
  ADD CONSTRAINT "pharmacy_migration_sources_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
COMMIT;
