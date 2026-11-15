BEGIN;

-- DEV-82 / #732 — live cold-chain sensor push. Additive only: manual entry, CSV
-- import, the append-only trigger, the range-flag trigger and the PUR-07
-- COLD_CHAIN rule are unchanged. An enrolled sensor is a third source behind
-- the same INV-05 seam. Every statement is safe to re-run.

ALTER TYPE "PharmacyTemperatureReadingSource" ADD VALUE IF NOT EXISTS 'SENSOR';

-- Sensor readings carry the device serial as evidence, exactly like logger
-- imports. Compared as text so this migration never uses the new enum label in
-- the transaction that added it.
ALTER TABLE "pharmacy_temperature_logs"
  DROP CONSTRAINT IF EXISTS "pharmacy_temperature_logs_evidence_check";
ALTER TABLE "pharmacy_temperature_logs"
  ADD CONSTRAINT "pharmacy_temperature_logs_evidence_check"
    CHECK (
      length(btrim("actorId")) > 0 AND
      "temperatureC" BETWEEN -100 AND 100 AND
      ("deviceIdentifier" IS NULL OR length(btrim("deviceIdentifier")) > 0) AND
      ("source"::text IN ('IMPORT', 'SENSOR') OR "deviceIdentifier" IS NULL)
    );

-- One enrolled sensor is bound to exactly one storage zone of one branch. Only
-- the SHA-256 hash of its push secret is stored; it is globally unique because
-- the webhook resolves the sensor BEFORE it knows the tenant. Revocation is a
-- state, never a deletion, so the evidence a sensor pushed stays attributable.
CREATE TABLE IF NOT EXISTS "pharmacy_cold_chain_sensors" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "stockLocationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "deviceIdentifier" TEXT NOT NULL,
  "secretHash" TEXT NOT NULL,
  "status" "PharmacyDeviceStatus" NOT NULL DEFAULT 'ACTIVE',
  "revokedAt" TIMESTAMP(3),
  "lastSeenAt" TIMESTAMP(3),
  "lastReadingAt" TIMESTAMP(3),
  "enrolledByActorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_cold_chain_sensors_name_check"
    CHECK (length(btrim("name")) > 0 AND length("name") <= 120),
  CONSTRAINT "pharmacy_cold_chain_sensors_device_identifier_check"
    CHECK (length(btrim("deviceIdentifier")) > 0 AND length("deviceIdentifier") <= 120),
  CONSTRAINT "pharmacy_cold_chain_sensors_actor_check"
    CHECK (length(btrim("enrolledByActorId")) > 0),
  CONSTRAINT "pharmacy_cold_chain_sensors_revocation_check"
    CHECK (("status" = 'REVOKED') = ("revokedAt" IS NOT NULL)),
  CONSTRAINT "pharmacy_cold_chain_sensors_secret_hash_check"
    CHECK ("secretHash" ~ '^[0-9a-f]{64}$')
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'pharmacy_cold_chain_sensors_org_id_key'
      AND conrelid = 'pharmacy_cold_chain_sensors'::regclass
  ) THEN
    ALTER TABLE "pharmacy_cold_chain_sensors"
      ADD CONSTRAINT "pharmacy_cold_chain_sensors_org_id_key" UNIQUE ("organizationId", "id");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'pharmacy_cold_chain_sensors_org_device_key'
      AND conrelid = 'pharmacy_cold_chain_sensors'::regclass
  ) THEN
    ALTER TABLE "pharmacy_cold_chain_sensors"
      ADD CONSTRAINT "pharmacy_cold_chain_sensors_org_device_key"
      UNIQUE ("organizationId", "deviceIdentifier");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'pharmacy_cold_chain_sensors_location_fkey'
      AND conrelid = 'pharmacy_cold_chain_sensors'::regclass
  ) THEN
    ALTER TABLE "pharmacy_cold_chain_sensors"
      ADD CONSTRAINT "pharmacy_cold_chain_sensors_location_fkey"
      FOREIGN KEY ("organizationId", "branchId", "stockLocationId")
      REFERENCES "pharmacy_stock_locations" ("organizationId", "branchId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_cold_chain_sensors_secret_hash_key"
  ON "pharmacy_cold_chain_sensors" ("secretHash");
CREATE INDEX IF NOT EXISTS "pharmacy_cold_chain_sensors_org_branch_location_idx"
  ON "pharmacy_cold_chain_sensors" ("organizationId", "branchId", "stockLocationId");

DROP TRIGGER IF EXISTS "pharmacy_cold_chain_sensors_no_delete" ON "pharmacy_cold_chain_sensors";
CREATE TRIGGER "pharmacy_cold_chain_sensors_no_delete"
  BEFORE DELETE ON "pharmacy_cold_chain_sensors"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();

-- Rows are tenant-scoped. The platform flag may only SELECT, which is the
-- single pre-tenant lookup the webhook performs (by secret hash); every write
-- and every reading insert then runs inside the resolved tenant scope.
ALTER TABLE "pharmacy_cold_chain_sensors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_cold_chain_sensors" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pharmacy_cold_chain_sensors_tenant_select" ON "pharmacy_cold_chain_sensors";
CREATE POLICY "pharmacy_cold_chain_sensors_tenant_select" ON "pharmacy_cold_chain_sensors"
  FOR SELECT USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
DROP POLICY IF EXISTS "pharmacy_cold_chain_sensors_tenant_insert" ON "pharmacy_cold_chain_sensors";
CREATE POLICY "pharmacy_cold_chain_sensors_tenant_insert" ON "pharmacy_cold_chain_sensors"
  FOR INSERT WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
DROP POLICY IF EXISTS "pharmacy_cold_chain_sensors_tenant_update" ON "pharmacy_cold_chain_sensors";
CREATE POLICY "pharmacy_cold_chain_sensors_tenant_update" ON "pharmacy_cold_chain_sensors"
  FOR UPDATE
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
DROP POLICY IF EXISTS "pharmacy_cold_chain_sensors_platform_discovery" ON "pharmacy_cold_chain_sensors";
CREATE POLICY "pharmacy_cold_chain_sensors_platform_discovery" ON "pharmacy_cold_chain_sensors"
  FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true');

COMMIT;
