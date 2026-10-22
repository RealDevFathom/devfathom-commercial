-- Loyalty 5/6: refill-reminder preferences and transactional queue metadata.
-- Additive for parallel delivery; rebase onto the sibling loyalty branches before merge.
CREATE TABLE "pharmacy_refill_reminder_preferences" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "patientId" TEXT NOT NULL,
  "optedOut" BOOLEAN NOT NULL DEFAULT false,
  "source" TEXT NOT NULL,
  "changedByUserId" TEXT,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_refill_reminder_preferences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_refill_reminder_preferences_source_check" CHECK ("source" IN ('STAFF', 'KEYWORD', 'LINK')),
  CONSTRAINT "pharmacy_refill_reminder_preferences_patient_fkey"
    FOREIGN KEY ("organizationId", "patientId") REFERENCES "pharmacy_patients"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pharmacy_refill_reminder_preferences_org_id_key" ON "pharmacy_refill_reminder_preferences"("organizationId", "id");
CREATE UNIQUE INDEX "pharmacy_refill_reminder_preferences_patient_key" ON "pharmacy_refill_reminder_preferences"("organizationId", "patientId");

ALTER TABLE "pharmacy_refill_reminder_captures"
  ADD COLUMN "statusReason" TEXT,
  ADD COLUMN "queuedAt" TIMESTAMP(3),
  ADD COLUMN "sentAt" TIMESTAMP(3);
ALTER TABLE "pharmacy_refill_reminder_captures"
  ADD CONSTRAINT "pharmacy_refill_reminder_capture_status_check"
  CHECK ("status" IN ('CAPTURED', 'QUEUED', 'SENT', 'SKIPPED'));
CREATE INDEX "pharmacy_refill_reminder_due_idx"
  ON "pharmacy_refill_reminder_captures"("organizationId", "status", "reminderAt", "id");

ALTER TABLE "pharmacy_message_logs"
  ADD COLUMN "templateLocale" TEXT,
  ADD COLUMN "templatePayload" JSONB;

ALTER TABLE "pharmacy_refill_reminder_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_refill_reminder_preferences" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pharmacy_refill_reminder_preferences"
  USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
