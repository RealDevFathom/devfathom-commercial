BEGIN;

-- The table forces RLS, including for a NOSUPERUSER/NOBYPASSRLS owner.
-- Keep administrative scope local to this atomic update.
SELECT set_config('app.is_platform_admin', 'true', true);

-- DEV-803: proposals still pending can never be confirmed. Move them to
-- NOT_APPLIED so the owner sees they were never applied. Confirmed rows and
-- all prices are untouched; the update is idempotent.
UPDATE "pharmacy_price_change_proposals"
SET "status" = 'NOT_APPLIED'
WHERE "status" = 'PROPOSED';

COMMIT;
