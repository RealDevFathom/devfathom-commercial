-- A server-owned cursor makes the per-device FIFO claim durable. Existing
-- devices resume immediately after their highest recorded sequence. Historical
-- gaps were left by rejected replays that rolled back before the cursor
-- existed; counters have already quarantined those commands and moved on, so
-- resuming at a gap would refuse every new sale from that counter on deploy.
ALTER TABLE "pharmacy_registered_devices"
  ADD COLUMN "nextOfflineCommandSequence" INTEGER NOT NULL DEFAULT 1;

-- FORCE RLS applies to the non-bypass migration owner as well. Platform scope
-- permits enumerating organizations, but the pharmacy tables require an
-- explicit tenant scope. Keep all settings inside this statement and restore
-- the caller's context without disabling any policy.
DO $$
DECLARE
  tenant_id TEXT;
  previous_tenant TEXT := current_setting('app.current_organization_id', true);
  previous_admin TEXT := current_setting('app.is_platform_admin', true);
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  FOR tenant_id IN SELECT id FROM organizations LOOP
    PERFORM set_config('app.current_organization_id', tenant_id, true);
    UPDATE "pharmacy_registered_devices" AS device
    SET "nextOfflineCommandSequence" = commands."nextSequence"
    FROM (
      -- Cast before incrementing so INTEGER maximum history cannot abort
      -- deployment; 2147483647 remains the terminal cursor.
      SELECT "organizationId", "deviceId",
        LEAST(MAX("sequence")::BIGINT + 1, 2147483647)::INTEGER AS "nextSequence"
      FROM "pharmacy_offline_commands"
      WHERE "organizationId" = tenant_id
      GROUP BY "organizationId", "deviceId"
    ) AS commands
    WHERE device."organizationId" = commands."organizationId"
      AND device."id" = commands."deviceId";
  END LOOP;
  PERFORM set_config('app.current_organization_id', COALESCE(previous_tenant, ''), true);
  PERFORM set_config('app.is_platform_admin', COALESCE(previous_admin, ''), true);
END;
$$;

ALTER TABLE "pharmacy_registered_devices"
  ADD CONSTRAINT "pharmacy_registered_devices_offline_sequence_check"
  CHECK ("nextOfflineCommandSequence" > 0);
