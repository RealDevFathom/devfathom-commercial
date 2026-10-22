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

-- The original capture-only constraint and generic append-only trigger reject
-- every lifecycle transition. Replace them with a narrow state machine while
-- keeping all clinical/capture evidence immutable and DELETE forbidden.
ALTER TABLE "pharmacy_refill_reminder_captures"
  DROP CONSTRAINT "pharmacy_refill_capture_mode_check",
  ADD CONSTRAINT "pharmacy_refill_capture_mode_check" CHECK ("captureMode"),
  ADD CONSTRAINT "pharmacy_refill_reminder_capture_status_check" CHECK (
    ("status" = 'CAPTURED' AND "statusReason" IS NULL AND "queuedAt" IS NULL AND "sentAt" IS NULL) OR
    ("status" = 'QUEUED' AND "statusReason" IS NULL AND "queuedAt" IS NOT NULL AND "sentAt" IS NULL) OR
    ("status" = 'SENT' AND "statusReason" IS NULL AND "queuedAt" IS NOT NULL AND "sentAt" IS NOT NULL) OR
    ("status" = 'SKIPPED' AND "statusReason" IS NOT NULL AND "queuedAt" IS NULL AND "sentAt" IS NULL)
  );

DROP TRIGGER "pharmacy_refill_capture_append_only" ON "pharmacy_refill_reminder_captures";
CREATE FUNCTION pharmacy_refill_capture_guard_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','statusReason','queuedAt','sentAt'])
       IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','statusReason','queuedAt','sentAt']) THEN
    RAISE EXCEPTION 'refill capture evidence is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD."status" = 'CAPTURED' AND NEW."status" IN ('QUEUED','SKIPPED')) OR
          (OLD."status" = 'QUEUED' AND NEW."status" = 'SENT')) THEN
    RAISE EXCEPTION 'invalid refill capture status transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "pharmacy_refill_capture_lifecycle_guard"
  BEFORE UPDATE OR DELETE ON "pharmacy_refill_reminder_captures"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_refill_capture_guard_transition();

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
