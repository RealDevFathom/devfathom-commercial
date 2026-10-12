-- RX-07 — PRD §6.6; §8 human-control rule; §8A invariants 11 and 21.
-- Capture-only reminder drafts stay inside the protected patient context.
CREATE TABLE "pharmacy_refill_reminder_captures" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "prescriptionFillId" TEXT NOT NULL,
  "patientId" TEXT NOT NULL,
  "channel" "PatientConsentChannel" NOT NULL,
  "consentEventId" TEXT NOT NULL,
  "pharmacistDecisionId" TEXT,
  "medicineName" TEXT NOT NULL,
  "strength" TEXT NOT NULL,
  "dosageForm" TEXT NOT NULL,
  "directionsEnglish" TEXT NOT NULL,
  "directionsUrdu" TEXT NOT NULL,
  "quantityDispensed" INTEGER NOT NULL,
  "dosesPerDay" DECIMAL(10,4) NOT NULL,
  "expectedExhaustionAt" TIMESTAMP(3) NOT NULL,
  "reminderAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'CAPTURED',
  "captureMode" BOOLEAN NOT NULL DEFAULT true,
  "capturedByUserId" TEXT NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idempotencyKey" TEXT NOT NULL,
  CONSTRAINT "pharmacy_refill_capture_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "pharmacy_refill_capture_org_fill_key" UNIQUE ("organizationId", "prescriptionFillId"),
  CONSTRAINT "pharmacy_refill_capture_org_idempotency_key" UNIQUE ("organizationId", "idempotencyKey"),
  CONSTRAINT "pharmacy_refill_capture_quantity_check" CHECK ("quantityDispensed" > 0),
  CONSTRAINT "pharmacy_refill_capture_dose_check" CHECK ("dosesPerDay" > 0),
  CONSTRAINT "pharmacy_refill_capture_dates_check" CHECK ("reminderAt" <= "expectedExhaustionAt"),
  CONSTRAINT "pharmacy_refill_capture_mode_check" CHECK ("captureMode" AND "status" = 'CAPTURED'),
  CONSTRAINT "pharmacy_refill_capture_text_check" CHECK (
    length(btrim("medicineName")) > 0 AND
    length(btrim("strength")) > 0 AND
    length(btrim("dosageForm")) > 0 AND
    length(btrim("directionsEnglish")) > 0 AND
    length(btrim("directionsUrdu")) > 0
  ),
  CONSTRAINT "pharmacy_refill_capture_branch_fkey"
    FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_refill_capture_fill_fkey"
    FOREIGN KEY ("organizationId", "prescriptionFillId")
    REFERENCES "pharmacy_prescription_fills"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_refill_capture_patient_fkey"
    FOREIGN KEY ("organizationId", "patientId")
    REFERENCES "pharmacy_patients"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_refill_capture_consent_fkey"
    FOREIGN KEY ("organizationId", "consentEventId")
    REFERENCES "pharmacy_patient_consents"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_refill_capture_pharmacist_fkey"
    FOREIGN KEY ("organizationId", "pharmacistDecisionId")
    REFERENCES "pharmacy_pharmacist_review_decisions"("organizationId", "id") ON DELETE RESTRICT
);

CREATE INDEX "pharmacy_refill_capture_org_branch_reminder_idx"
  ON "pharmacy_refill_reminder_captures"("organizationId", "branchId", "reminderAt");
CREATE INDEX "pharmacy_refill_capture_org_patient_captured_idx"
  ON "pharmacy_refill_reminder_captures"("organizationId", "patientId", "capturedAt");

CREATE TRIGGER pharmacy_refill_capture_append_only
  BEFORE UPDATE OR DELETE ON "pharmacy_refill_reminder_captures"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_rx_reject_append_only_change();

ALTER TABLE "pharmacy_refill_reminder_captures" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_refill_reminder_captures" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_branch_isolation ON "pharmacy_refill_reminder_captures"
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR
    (
      "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
      (
        NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
        "branchId" = current_setting('app.current_branch_id', true)
      )
    )
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR
    (
      "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
      (
        NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
        "branchId" = current_setting('app.current_branch_id', true)
      )
    )
  );
