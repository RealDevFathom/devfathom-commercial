BEGIN;

-- The old counter was price-check only. Its open grants did not reserve stock while
-- selling was off. Keep the grant and its consumption history, and audit its release.
-- Prisma's deployment time bounds the repair even when the SQL is run again later.
SELECT set_config('app.is_platform_admin', 'true', true);

DO $$
DECLARE
  tenant_id text;
  cutover timestamptz;
BEGIN
  SELECT min(started_at) INTO cutover FROM "_prisma_migrations"
    WHERE migration_name = '20261118127200_reconcile_offline_set_asides'
      AND rolled_back_at IS NULL;
  IF cutover IS NULL THEN
    RAISE EXCEPTION 'Missing offline set-aside migration start time';
  END IF;
  FOR tenant_id IN SELECT id FROM organizations ORDER BY id LOOP
    PERFORM set_config('app.current_organization_id', tenant_id, true);
    PERFORM set_config('app.current_branch_id', '', true);
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
