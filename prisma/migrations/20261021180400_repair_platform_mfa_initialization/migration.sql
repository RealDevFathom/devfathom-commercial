-- Replay the original data predicate under platform scope (#218).
-- Preserve configured department names and enrolled MFA users.
BEGIN;
SELECT set_config('app.is_platform_admin', 'true', true);

UPDATE "platform_users" SET "mfaRequired" = false
WHERE "mfaEnabledAt" IS NULL AND "mfaRequired" = true;

COMMIT;
