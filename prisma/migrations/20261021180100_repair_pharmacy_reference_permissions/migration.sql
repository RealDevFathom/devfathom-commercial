-- Intentionally no data replay: Do not resurrect catalogue-review grants that administrators may have removed.
BEGIN;
SELECT set_config('app.is_platform_admin', 'true', true);
COMMIT;
