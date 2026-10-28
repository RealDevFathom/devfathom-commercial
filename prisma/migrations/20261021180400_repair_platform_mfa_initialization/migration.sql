-- Intentionally no data replay: Do not clear required MFA on existing platform administrators.
BEGIN;
SELECT set_config('app.is_platform_admin', 'true', true);
COMMIT;
