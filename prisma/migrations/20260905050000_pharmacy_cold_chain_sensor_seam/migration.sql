-- INV-05 P1: manual and data-logger temperature ingestion in front of the
-- existing cold-chain storage and PUR-07 breach rules. No signal table or
-- cold-chain stock rule is replaced here.

ALTER TABLE "pharmacy_stock_locations"
  ADD COLUMN "expectedTemperatureReadingIntervalMinutes" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN "temperatureExcursionDurationMinutes" INTEGER NOT NULL DEFAULT 30,
  ADD CONSTRAINT "pharmacy_stock_locations_temperature_monitoring_check"
    CHECK (
      "expectedTemperatureReadingIntervalMinutes" BETWEEN 1 AND 10080 AND
      "temperatureExcursionDurationMinutes" BETWEEN 1 AND 10080
    );

CREATE TYPE "PharmacyTemperatureReadingSource" AS ENUM ('MANUAL', 'IMPORT');

ALTER TABLE "pharmacy_temperature_logs"
  DROP CONSTRAINT "pharmacy_temperature_logs_evidence_check";

ALTER TABLE "pharmacy_temperature_logs"
  ALTER COLUMN "source" DROP DEFAULT,
  ALTER COLUMN "source" TYPE "PharmacyTemperatureReadingSource"
    USING ("source"::"PharmacyTemperatureReadingSource"),
  ALTER COLUMN "source" SET DEFAULT 'MANUAL',
  ADD COLUMN "deviceIdentifier" TEXT;

ALTER TABLE "pharmacy_temperature_logs"
  ADD CONSTRAINT "pharmacy_temperature_logs_evidence_check"
    CHECK (
      length(btrim("actorId")) > 0 AND
      "temperatureC" BETWEEN -100 AND 100 AND
      ("deviceIdentifier" IS NULL OR length(btrim("deviceIdentifier")) > 0) AND
      ("source" = 'IMPORT' OR "deviceIdentifier" IS NULL)
    );

-- Ambient locations may retain operational readings, but without a validated
-- range they are never classified as out of range and therefore cannot feed a
-- temperature excursion into PUR-07. The existing FK still rejects a missing
-- or cross-scope location, and the append-only trigger remains unchanged.
CREATE OR REPLACE FUNCTION pharmacy_set_temperature_range_flag() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE zone_min double precision; zone_max double precision; zone_validated boolean;
BEGIN
  SELECT "minimumTemperatureC", "maximumTemperatureC", "coldChain"
    INTO zone_min, zone_max, zone_validated
    FROM "pharmacy_stock_locations"
   WHERE "organizationId" = NEW."organizationId"
     AND "branchId" = NEW."branchId"
     AND "id" = NEW."stockLocationId";

  IF zone_validated IS TRUE THEN
    IF zone_min IS NULL OR zone_max IS NULL THEN
      RAISE EXCEPTION 'validated cold-chain location requires a temperature range' USING ERRCODE = '23514';
    END IF;
    NEW."outOfRange" := NEW."temperatureC" < zone_min OR NEW."temperatureC" > zone_max;
  ELSE
    NEW."outOfRange" := false;
  END IF;
  RETURN NEW;
END $$;
