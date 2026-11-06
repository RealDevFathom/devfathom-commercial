-- Legacy rows have no reliable cross-channel ordering and stay unsequenced.
-- A new purpose decision is required before a consumer may rely on this order.
ALTER TABLE "pharmacy_patient_consents" ADD COLUMN "purposeSequence" INTEGER;

CREATE UNIQUE INDEX "pharmacy_consent_purpose_sequence_key"
  ON "pharmacy_patient_consents" ("organizationId", "patientId", "purpose", "purposeSequence")
  WHERE "purposeSequence" IS NOT NULL;

CREATE FUNCTION pharmacy_assign_consent_purpose_sequence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE next_sequence INTEGER;
BEGIN
  PERFORM 1 FROM "pharmacy_patients"
    WHERE "organizationId" = NEW."organizationId" AND id = NEW."patientId"
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Patient unavailable in this workspace';
  END IF;
  SELECT COALESCE(MAX("purposeSequence"), 0) + 1 INTO next_sequence
    FROM "pharmacy_patient_consents"
    WHERE "organizationId" = NEW."organizationId"
      AND "patientId" = NEW."patientId" AND purpose = NEW.purpose;
  NEW."purposeSequence" := next_sequence;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pharmacy_consent_purpose_sequence
  BEFORE INSERT ON "pharmacy_patient_consents"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_assign_consent_purpose_sequence();
