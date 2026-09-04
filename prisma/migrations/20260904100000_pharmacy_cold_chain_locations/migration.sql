-- INV-05: validated cold-chain zones and immutable manual temperature evidence.
ALTER TABLE "pharmacy_stock_locations"
  ADD COLUMN "minimumTemperatureC" DOUBLE PRECISION,
  ADD COLUMN "maximumTemperatureC" DOUBLE PRECISION;

-- The existing `coldChain` flag already meant validated storage. Preserve those
-- zones with the standard refrigerator range rather than silently invalidating them.
UPDATE "pharmacy_stock_locations"
SET "minimumTemperatureC" = 2, "maximumTemperatureC" = 8
WHERE "coldChain" = true;

ALTER TABLE "pharmacy_stock_locations"
  ADD CONSTRAINT "pharmacy_stock_locations_cold_chain_range_check"
  CHECK (
    "coldChain" = false OR
    ("minimumTemperatureC" IS NOT NULL AND "maximumTemperatureC" IS NOT NULL AND
     "minimumTemperatureC" < "maximumTemperatureC")
  );

CREATE TABLE "pharmacy_temperature_logs" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "stockLocationId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "temperatureC" DOUBLE PRECISION NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL,
  "outOfRange" BOOLEAN NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'MANUAL',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_temperature_logs_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "pharmacy_temperature_logs_location_fkey"
    FOREIGN KEY ("organizationId", "branchId", "stockLocationId")
    REFERENCES "pharmacy_stock_locations" ("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_temperature_logs_evidence_check"
    CHECK (length(btrim("actorId")) > 0 AND length(btrim("source")) > 0 AND
           "temperatureC" BETWEEN -100 AND 100)
);
CREATE INDEX "pharmacy_temperature_logs_zone_time_idx"
  ON "pharmacy_temperature_logs" ("organizationId", "branchId", "stockLocationId", "recordedAt");

CREATE TRIGGER pharmacy_temperature_logs_append_only
BEFORE UPDATE OR DELETE ON "pharmacy_temperature_logs"
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();

ALTER TABLE "pharmacy_temperature_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_temperature_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_branch_isolation ON "pharmacy_temperature_logs"
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

CREATE FUNCTION pharmacy_set_temperature_range_flag() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE zone_min double precision; zone_max double precision; zone_validated boolean;
BEGIN
  SELECT "minimumTemperatureC", "maximumTemperatureC", "coldChain"
    INTO zone_min, zone_max, zone_validated
    FROM "pharmacy_stock_locations"
   WHERE "organizationId" = NEW."organizationId"
     AND "branchId" = NEW."branchId"
     AND "id" = NEW."stockLocationId";
  IF zone_validated IS DISTINCT FROM TRUE OR zone_min IS NULL OR zone_max IS NULL THEN
    RAISE EXCEPTION 'temperature readings require a validated cold-chain location' USING ERRCODE = '23514';
  END IF;
  NEW."outOfRange" := NEW."temperatureC" < zone_min OR NEW."temperatureC" > zone_max;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_temperature_logs_range_flag
BEFORE INSERT ON "pharmacy_temperature_logs"
FOR EACH ROW EXECUTE FUNCTION pharmacy_set_temperature_range_flag();

-- Defense in depth: direct SQL and future adapters cannot place available
-- cold-chain stock into an ambient/non-validated location.
CREATE FUNCTION pharmacy_assert_cold_chain_storage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE medicine_cold_chain boolean; location_validated boolean;
BEGIN
  IF NEW."quantityUnits" <= 0 OR NEW."disposition" <> 'AVAILABLE' THEN RETURN NEW; END IF;
  SELECT medicine."coldChain" INTO medicine_cold_chain
    FROM "pharmacy_inventory_lots" lot
    JOIN "pharmacy_manufacturing_batches" batch
      ON batch."organizationId" = lot."organizationId" AND batch."id" = lot."manufacturingBatchId"
    JOIN "pharmacy_medicines" medicine
      ON medicine."organizationId" = batch."organizationId" AND medicine."id" = batch."medicineId"
   WHERE lot."organizationId" = NEW."organizationId" AND lot."id" = NEW."inventoryLotId";
  IF medicine_cold_chain IS TRUE THEN
    SELECT "coldChain" INTO location_validated FROM "pharmacy_stock_locations"
     WHERE "organizationId" = NEW."organizationId" AND "id" = NEW."stockLocationId";
    IF location_validated IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'cold-chain stock requires a validated cold-chain location' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_stock_movement_cold_chain_storage
BEFORE INSERT ON "pharmacy_stock_movements"
FOR EACH ROW EXECUTE FUNCTION pharmacy_assert_cold_chain_storage();
