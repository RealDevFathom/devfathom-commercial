-- PH-RX — PRD §6.6 RX-01/RX-02; §8A invariants 11, 14, 20 and 21.
CREATE TYPE "PatientConsentPurpose" AS ENUM ('DISPENSING','REMINDERS','LOYALTY','MARKETING');
CREATE TYPE "PatientConsentChannel" AS ENUM ('IN_PERSON','PHONE','SMS','WHATSAPP','EMAIL');
CREATE TYPE "PrescriptionSourceKind" AS ENUM ('PAPER_IMAGE','WHATSAPP_PHOTO');
CREATE TYPE "PrescriptionCustodyState" AS ENUM ('NOT_HELD','HELD_AT_PHARMACY','RETURNED_TO_PATIENT','TRANSFERRED');

CREATE TABLE "pharmacy_patients" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "displayName" TEXT NOT NULL CHECK (length(btrim("displayName")) > 0),
  "cnic" TEXT, "phone" TEXT, "dateOfBirth" DATE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("organizationId", "id")
);

CREATE TABLE "pharmacy_patient_consents" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "patientId" TEXT NOT NULL, "purpose" "PatientConsentPurpose" NOT NULL,
  "channel" "PatientConsentChannel" NOT NULL, "version" INTEGER NOT NULL CHECK ("version" > 0),
  "granted" BOOLEAN NOT NULL, "recordedByUserId" TEXT NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "revokedAt" TIMESTAMP(3),
  "supersedesId" TEXT, UNIQUE ("organizationId", "id"),
  UNIQUE ("organizationId", "patientId", "purpose", "channel", "version"),
  CHECK (("granted" AND "revokedAt" IS NULL) OR (NOT "granted" AND "revokedAt" IS NOT NULL)),
  FOREIGN KEY ("organizationId", "patientId") REFERENCES "pharmacy_patients"("organizationId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "supersedesId") REFERENCES "pharmacy_patient_consents"("organizationId", "id") ON DELETE RESTRICT
);

CREATE TABLE "pharmacy_prescribers" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "name" TEXT NOT NULL CHECK (length(btrim("name")) > 0), "registrationNumber" TEXT NOT NULL,
  "phone" TEXT, "facility" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "id"), UNIQUE ("organizationId", "registrationNumber")
);

CREATE TABLE "pharmacy_prescriptions" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "patientId" TEXT NOT NULL, "prescriberId" TEXT NOT NULL,
  "sourceKind" "PrescriptionSourceKind" NOT NULL, "sourceFileRef" TEXT NOT NULL CHECK (length(btrim("sourceFileRef")) > 0),
  "custodyState" "PrescriptionCustodyState" NOT NULL DEFAULT 'NOT_HELD',
  "validFrom" TIMESTAMP(3) NOT NULL, "validUntil" TIMESTAMP(3) NOT NULL,
  "authorizedRepeats" INTEGER NOT NULL DEFAULT 0 CHECK ("authorizedRepeats" >= 0),
  "capturedByUserId" TEXT NOT NULL, "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "id"), CHECK ("validUntil" >= "validFrom"),
  FOREIGN KEY ("organizationId", "patientId") REFERENCES "pharmacy_patients"("organizationId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "prescriberId") REFERENCES "pharmacy_prescribers"("organizationId", "id") ON DELETE RESTRICT
);

CREATE TABLE "pharmacy_prescription_lines" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "prescriptionId" TEXT NOT NULL, "lineNumber" INTEGER NOT NULL CHECK ("lineNumber" > 0),
  "medicineId" TEXT NOT NULL REFERENCES "pharmacy_medicines"("id") ON DELETE RESTRICT,
  "presentationId" TEXT NOT NULL REFERENCES "pharmacy_presentations"("id") ON DELETE RESTRICT,
  "authorizedCanonicalUnits" INTEGER NOT NULL CHECK ("authorizedCanonicalUnits" > 0),
  "directions" TEXT NOT NULL CHECK (length(btrim("directions")) > 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "id"), UNIQUE ("organizationId", "prescriptionId", "lineNumber"),
  FOREIGN KEY ("organizationId", "prescriptionId") REFERENCES "pharmacy_prescriptions"("organizationId", "id") ON DELETE RESTRICT
);

CREATE TABLE "pharmacy_prescription_fills" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "prescriptionLineId" TEXT NOT NULL, "fillSequence" INTEGER NOT NULL CHECK ("fillSequence" > 0),
  "quantityCanonicalUnits" INTEGER NOT NULL CHECK ("quantityCanonicalUnits" > 0),
  "dispensedByUserId" TEXT NOT NULL, "dispensedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idempotencyKey" TEXT NOT NULL, UNIQUE ("organizationId", "id"),
  UNIQUE ("organizationId", "prescriptionLineId", "fillSequence"), UNIQUE ("organizationId", "idempotencyKey"),
  FOREIGN KEY ("organizationId", "prescriptionLineId") REFERENCES "pharmacy_prescription_lines"("organizationId", "id") ON DELETE RESTRICT
);

CREATE FUNCTION pharmacy_rx_reject_append_only_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514'; END $$;
CREATE TRIGGER pharmacy_consent_append_only BEFORE UPDATE OR DELETE ON "pharmacy_patient_consents" FOR EACH ROW EXECUTE FUNCTION pharmacy_rx_reject_append_only_change();
CREATE TRIGGER pharmacy_prescription_append_only BEFORE UPDATE OR DELETE ON "pharmacy_prescriptions" FOR EACH ROW EXECUTE FUNCTION pharmacy_rx_reject_append_only_change();
CREATE TRIGGER pharmacy_prescription_line_append_only BEFORE UPDATE OR DELETE ON "pharmacy_prescription_lines" FOR EACH ROW EXECUTE FUNCTION pharmacy_rx_reject_append_only_change();
CREATE TRIGGER pharmacy_prescription_fill_append_only BEFORE UPDATE OR DELETE ON "pharmacy_prescription_fills" FOR EACH ROW EXECUTE FUNCTION pharmacy_rx_reject_append_only_change();

-- Serialize fills on their immutable line. This closes the concurrent double-fill race.
CREATE FUNCTION pharmacy_rx_assert_fill_remaining() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed_units integer; used_units bigint; allowed_events integer; used_events bigint;
BEGIN
  SELECT l."authorizedCanonicalUnits", p."authorizedRepeats" + 1
    INTO allowed_units, allowed_events
    FROM "pharmacy_prescription_lines" l
    JOIN "pharmacy_prescriptions" p ON p."organizationId"=l."organizationId" AND p."id"=l."prescriptionId"
   WHERE l."organizationId"=NEW."organizationId" AND l."id"=NEW."prescriptionLineId"
   FOR UPDATE OF l;
  IF allowed_units IS NULL THEN RAISE EXCEPTION 'prescription line is unavailable' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(sum("quantityCanonicalUnits"),0), count(*) INTO used_units, used_events
    FROM "pharmacy_prescription_fills" WHERE "organizationId"=NEW."organizationId" AND "prescriptionLineId"=NEW."prescriptionLineId";
  IF used_units + NEW."quantityCanonicalUnits" > allowed_units THEN RAISE EXCEPTION 'fill exceeds remaining authorized quantity' USING ERRCODE='23514'; END IF;
  IF used_events + 1 > allowed_events THEN RAISE EXCEPTION 'fill exceeds authorized repeats' USING ERRCODE='23514'; END IF;
  IF NEW."fillSequence" <> used_events + 1 THEN RAISE EXCEPTION 'fill sequence must be cumulative' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_prescription_fill_remaining BEFORE INSERT ON "pharmacy_prescription_fills" FOR EACH ROW EXECUTE FUNCTION pharmacy_rx_assert_fill_remaining();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_patients','pharmacy_patient_consents','pharmacy_prescribers','pharmacy_prescriptions','pharmacy_prescription_lines','pharmacy_prescription_fills'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.is_platform_admin'',true)=''true'' OR "organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),'''')) WITH CHECK (current_setting(''app.is_platform_admin'',true)=''true'' OR "organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),''''))',t);
  END LOOP;
END $$;
