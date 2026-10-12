-- CAM-3 — camera presets, the cold-chain zone binding, and excursion evidence.
--
-- Additive only: every new column is nullable, no row is rewritten, and the
-- CAM-2 counter-evidence rows satisfy every replaced constraint unchanged.
--
-- The new CameraEvidenceSubject value is not usable inside the transaction
-- that adds it, so the constraints below compare "subjectKind"::text instead of
-- naming the enum literal.

-- CreateEnum
CREATE TYPE "CameraPreset" AS ENUM ('COLD_CHAIN', 'COUNTER', 'KITCHEN');

-- AlterEnum
ALTER TYPE "CameraEvidenceSubject" ADD VALUE 'PHARMACY_TEMPERATURE_EXCURSION';

-- AlterTable
ALTER TABLE "cameras" ADD COLUMN "preset" "CameraPreset",
ADD COLUMN "temperatureZoneId" TEXT;

-- AlterTable
ALTER TABLE "restaurant_cameras" ADD COLUMN "preset" "CameraPreset";

-- AlterTable
ALTER TABLE "camera_evidence" ADD COLUMN "readingRecordedAt" TIMESTAMP(3),
ADD COLUMN "readingTemperatureC" DOUBLE PRECISION,
ADD COLUMN "temperatureZoneId" TEXT;

-- CreateIndex
CREATE INDEX "cameras_organizationId_temperatureZoneId_idx" ON "cameras"("organizationId", "temperatureZoneId");

-- CreateIndex
CREATE INDEX "camera_evidence_organizationId_temperatureZoneId_idx" ON "camera_evidence"("organizationId", "temperatureZoneId");


-- Integrity the Prisma schema cannot express.

-- Only a cold-chain camera watches a temperature zone, and it always names one.
ALTER TABLE "cameras"
  ADD CONSTRAINT "cameras_temperature_zone_check"
    CHECK (COALESCE("preset" = 'COLD_CHAIN', false) = ("temperatureZoneId" IS NOT NULL));

-- Restaurants have no temperature zones: kitchen and counter only.
ALTER TABLE "restaurant_cameras"
  ADD CONSTRAINT "restaurant_cameras_preset_check"
    CHECK ("preset" IS NULL OR "preset" IN ('KITCHEN', 'COUNTER'));

-- A tender or refund names its sale; nothing else does. Same meaning as the
-- CAM-2 check for the three existing subjects.
ALTER TABLE "camera_evidence"
  DROP CONSTRAINT "camera_evidence_sale_binding_check",
  ADD CONSTRAINT "camera_evidence_sale_binding_check"
    CHECK (("subjectKind"::text IN ('PHARMACY_TENDER', 'PHARMACY_REFUND')) = ("saleId" IS NOT NULL)),
  ADD CONSTRAINT "camera_evidence_reading_binding_check"
    CHECK (
      ("subjectKind"::text = 'PHARMACY_TEMPERATURE_EXCURSION')
      = ("temperatureZoneId" IS NOT NULL AND "readingTemperatureC" IS NOT NULL AND "readingRecordedAt" IS NOT NULL)
    ),
  ADD CONSTRAINT "camera_evidence_reading_partial_check"
    CHECK (
      ("temperatureZoneId" IS NULL AND "readingTemperatureC" IS NULL AND "readingRecordedAt" IS NULL)
      OR ("temperatureZoneId" IS NOT NULL AND "readingTemperatureC" IS NOT NULL AND "readingRecordedAt" IS NOT NULL)
    );

-- The reading is part of the binding: as immutable as the subject it explains.
CREATE OR REPLACE FUNCTION camera_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId" THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'camera evidence is retained; retention clears the still, not the row'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."branchId" IS DISTINCT FROM OLD."branchId"
     OR NEW."subjectKind" IS DISTINCT FROM OLD."subjectKind"
     OR NEW."subjectId" IS DISTINCT FROM OLD."subjectId"
     OR NEW."saleId" IS DISTINCT FROM OLD."saleId"
     OR NEW."cameraId" IS DISTINCT FROM OLD."cameraId"
     OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt"
     OR NEW."temperatureZoneId" IS DISTINCT FROM OLD."temperatureZoneId"
     OR NEW."readingTemperatureC" IS DISTINCT FROM OLD."readingTemperatureC"
     OR NEW."readingRecordedAt" IS DISTINCT FROM OLD."readingRecordedAt" THEN
    RAISE EXCEPTION 'camera evidence binding is immutable' USING ERRCODE = '23514';
  END IF;

  IF NOT (
       (OLD."status" = 'PENDING' AND NEW."status" IN ('CAPTURED', 'FAILED'))
    OR (OLD."status" = 'CAPTURED' AND NEW."status" = 'PURGED'
        AND NEW."capturedAt" = OLD."capturedAt"
        AND NEW."byteLength" IS NOT DISTINCT FROM OLD."byteLength")
  ) THEN
    RAISE EXCEPTION 'camera evidence cannot move from % to %', OLD."status", NEW."status"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
