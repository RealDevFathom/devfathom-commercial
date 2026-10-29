-- #757: explicit consent provenance and fail-closed marketing eligibility.
CREATE TYPE "PatientConsentSource" AS ENUM ('COUNTER_TABLET', 'QR', 'REPLY', 'LEGACY');

ALTER TABLE "pharmacy_patient_consents"
  ADD COLUMN "source" "PatientConsentSource" NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN "staffId" TEXT;

-- Human-assisted capture must identify the staff member; self-service reply/QR
-- events retain recordedByUserId as the customer/system actor instead.
ALTER TABLE "pharmacy_patient_consents" ADD CONSTRAINT "pharmacy_patient_consent_staff_source_check"
  CHECK (("source" = 'COUNTER_TABLET' AND "staffId" IS NOT NULL AND length(btrim("staffId")) > 0)
      OR ("source" <> 'COUNTER_TABLET'));
CREATE INDEX "pharmacy_patient_consents_current_marketing_idx"
  ON "pharmacy_patient_consents" ("organizationId", "patientId", "purpose", "channel", "version" DESC);
