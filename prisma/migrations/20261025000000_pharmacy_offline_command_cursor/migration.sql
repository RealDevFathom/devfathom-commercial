-- A server-owned cursor makes the per-device FIFO claim durable. Existing
-- devices resume at their first missing positive sequence. This preserves a
-- delayed command below a historical gap instead of silently skipping it.
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
      -- LAG identifies the first gap without generating every integer up to the
      -- maximum. Cast before incrementing so INTEGER maximum history cannot abort
      -- deployment; 2147483647 remains the terminal cursor.
      SELECT "organizationId", "deviceId",
        LEAST(MIN(
          CASE
            WHEN "previousSequence" IS NULL AND "sequence" > 1 THEN 1::BIGINT
            WHEN "previousSequence" IS NOT NULL AND "sequence"::BIGINT > "previousSequence"::BIGINT + 1
              THEN "previousSequence"::BIGINT + 1
            WHEN "sequence" = "maximumSequence" THEN "sequence"::BIGINT + 1
          END
        ), 2147483647)::INTEGER AS "nextSequence"
      FROM (
        SELECT "organizationId", "deviceId", "sequence",
          LAG("sequence") OVER (PARTITION BY "organizationId", "deviceId" ORDER BY "sequence") AS "previousSequence",
          MAX("sequence") OVER (PARTITION BY "organizationId", "deviceId") AS "maximumSequence"
        FROM "pharmacy_offline_commands"
        WHERE "organizationId" = tenant_id
      ) AS ordered_commands
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
