-- Keep direct SQL and any future write surface from persisting an impossible
-- meeting duration. Application validation supplies the user-facing error.
-- Repair legacy rows accepted before #451 so deploying the constraint cannot
-- strand an existing tenant on a failed migration.
BEGIN;

-- FORCE RLS also applies to a non-bypassing table owner. Repair every tenant's
-- legacy rows, and release the platform scope when this transaction commits.
SELECT set_config('app.is_platform_admin', 'true', true);

-- Block legacy writers before taking the repair snapshot. Keep this lock until
-- the constraint is installed so no invalid row can slip between the two.
LOCK TABLE "meetings" IN ACCESS EXCLUSIVE MODE;

UPDATE "meetings"
SET "endTime" = "startTime" + INTERVAL '1 minute'
WHERE "endTime" <= "startTime";

ALTER TABLE "meetings"
    ADD CONSTRAINT "meetings_time_order_check" CHECK ("endTime" > "startTime") NOT VALID;

COMMIT;

-- Keep the validation scan out of the ACCESS EXCLUSIVE lock used to install
-- the constraint. New writes are protected as soon as the NOT VALID constraint
-- exists, while PostgreSQL validates the repaired history under the weaker
-- SHARE UPDATE EXCLUSIVE lock.
ALTER TABLE "meetings"
    VALIDATE CONSTRAINT "meetings_time_order_check";
