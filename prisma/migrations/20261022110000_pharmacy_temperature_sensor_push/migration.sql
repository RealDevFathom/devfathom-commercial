-- INV-05 v3: authenticated live cold-chain sensor push. Secrets are encrypted
-- by the application and every database access remains tenant/RLS scoped.
ALTER TYPE "PharmacyTemperatureReadingSource" ADD VALUE 'SENSOR';

CREATE TABLE "pharmacy_temperature_devices" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "stockLocationId" TEXT NOT NULL,
  "keyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "encryptedSigningSecret" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "lastSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_temperature_devices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_temperature_devices_location_fkey"
    FOREIGN KEY ("organizationId", "branchId", "stockLocationId")
    REFERENCES "pharmacy_stock_locations" ("organizationId", "branchId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_temperature_devices_secret_check"
    CHECK (length(btrim("keyId")) > 0 AND length(btrim("name")) > 0 AND length("encryptedSigningSecret") > 0)
);

CREATE UNIQUE INDEX "pharmacy_temperature_devices_org_id_key"
  ON "pharmacy_temperature_devices" ("organizationId", "id");
CREATE UNIQUE INDEX "pharmacy_temperature_devices_org_key_id_key"
  ON "pharmacy_temperature_devices" ("organizationId", "keyId");
CREATE INDEX "pharmacy_temperature_devices_org_branch_active_idx"
  ON "pharmacy_temperature_devices" ("organizationId", "branchId", "active");

ALTER TABLE "pharmacy_temperature_devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_temperature_devices" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pharmacy_temperature_devices"
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
      "branchId" = current_setting('app.current_branch_id', true)))
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
      "branchId" = current_setting('app.current_branch_id', true)))
  );

ALTER TABLE "pharmacy_temperature_logs" ADD COLUMN "externalReadingId" TEXT;
CREATE UNIQUE INDEX "pharmacy_temperature_logs_sensor_reading_key"
  ON "pharmacy_temperature_logs" ("organizationId", "deviceIdentifier", "externalReadingId");

ALTER TABLE "pharmacy_temperature_logs"
  DROP CONSTRAINT "pharmacy_temperature_logs_evidence_check";
ALTER TABLE "pharmacy_temperature_logs"
  ADD CONSTRAINT "pharmacy_temperature_logs_evidence_check" CHECK (
    length(btrim("actorId")) > 0 AND
    "temperatureC" BETWEEN -100 AND 100 AND
    ("deviceIdentifier" IS NULL OR length(btrim("deviceIdentifier")) > 0) AND
    ("externalReadingId" IS NULL OR length(btrim("externalReadingId")) > 0) AND
    (("source" = 'IMPORT' AND "externalReadingId" IS NULL) OR
     ("source" = 'SENSOR' AND "deviceIdentifier" IS NOT NULL AND "externalReadingId" IS NOT NULL) OR
     ("source" = 'MANUAL' AND "deviceIdentifier" IS NULL AND "externalReadingId" IS NULL))
  );
