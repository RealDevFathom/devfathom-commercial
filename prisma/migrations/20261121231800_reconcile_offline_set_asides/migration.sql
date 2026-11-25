BEGIN;
SET LOCAL lock_timeout = '10s';

-- The old counter was price-check only. Its open grants did not reserve stock while
-- selling was off. Keep the grant and its consumption history, and audit its release.
-- Prisma's deployment time bounds the repair even when the SQL is run again later.
SELECT set_config('app.is_platform_admin', 'true', true);

DO $$
DECLARE
  tenant_id text;
  cutover timestamptz;
BEGIN
  -- Prisma replays schema history into an empty shadow without its deployment ledger.
  IF to_regclass('_prisma_migrations') IS NOT NULL THEN
    SELECT min(started_at) INTO cutover FROM "_prisma_migrations"
      WHERE migration_name = '20261121231800_reconcile_offline_set_asides'
        AND rolled_back_at IS NULL;
  END IF;
  FOR tenant_id IN SELECT id FROM organizations ORDER BY id LOOP
    PERFORM set_config('app.current_organization_id', tenant_id, true);
    PERFORM set_config('app.current_branch_id', '', true);
    -- An empty rebuild has nothing to reconcile. On a populated database an
    -- unknown cutoff cannot safely distinguish historical and current grants.
    IF cutover IS NULL AND EXISTS (SELECT FROM pharmacy_device_lot_quotas
      WHERE "organizationId" = tenant_id AND "releasedAt" IS NULL) THEN
      RAISE EXCEPTION 'Missing offline set-aside migration start time for existing grants';
    END IF;
    WITH released AS (
      UPDATE pharmacy_device_lot_quotas
        SET "releasedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "organizationId" = tenant_id AND "releasedAt" IS NULL
          AND "grantedAt" < (cutover AT TIME ZONE 'UTC')
        RETURNING *
    )
    INSERT INTO audit_logs (id, "organizationId", "actorType", source, category, operation,
                            action, "targetType", "targetId", metadata)
      SELECT gen_random_uuid()::text, tenant_id, 'SYSTEM', 'SYSTEM', 'PHARMACY', 'UPDATE',
             'pharmacyOffline.releaseLegacyQuota', 'PharmacyDeviceLotQuota', id,
             jsonb_build_object('branchId', "branchId", 'deviceId', "deviceId",
               'unitsReleased', "quotaUnits" - "consumedUnits")
        FROM released;
  END LOOP;
  PERFORM set_config('app.current_organization_id', '', true);
END $$;

COMMIT;
