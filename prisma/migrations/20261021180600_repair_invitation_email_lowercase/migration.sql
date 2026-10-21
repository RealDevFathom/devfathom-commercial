-- Replay a silent FORCE-RLS write under transaction-local platform scope (#218).
BEGIN;
SELECT set_config('app.is_platform_admin', 'true', true);

UPDATE "invitations"
SET "email" = lower(btrim("email"))
WHERE "email" <> lower(btrim("email"));

COMMIT;
