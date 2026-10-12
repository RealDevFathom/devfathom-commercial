-- PH-SAFE — PRD §6.7 SAFE-02/SAFE-03/SAFE-04.
CREATE TYPE "PharmacyRecordClass" AS ENUM ('PRESCRIPTION','CONTROLLED_REGISTER','FISCAL','AUDIT');
CREATE TYPE "PharmacyLegalHoldEventKind" AS ENUM ('PLACED','RELEASED');

CREATE TABLE "pharmacy_retention_classes" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "recordClass" "PharmacyRecordClass" NOT NULL,
  "retentionDays" INTEGER NOT NULL CHECK ("retentionDays" > 0),
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "reason" TEXT NOT NULL CHECK (length(btrim("reason")) > 0),
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "recordClass", "effectiveFrom")
);
CREATE INDEX "pharmacy_retention_classes_lookup_idx" ON "pharmacy_retention_classes"("organizationId", "recordClass", "effectiveFrom");

CREATE TABLE "pharmacy_legal_hold_events" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "holdKey" TEXT NOT NULL CHECK (length(btrim("holdKey")) > 0),
  "recordClass" "PharmacyRecordClass" NOT NULL,
  "recordId" TEXT NOT NULL CHECK (length(btrim("recordId")) > 0),
  "kind" "PharmacyLegalHoldEventKind" NOT NULL,
  "reason" TEXT NOT NULL CHECK (length(btrim("reason")) > 0),
  "actorUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "holdKey", "createdAt")
);
CREATE INDEX "pharmacy_legal_hold_events_lookup_idx" ON "pharmacy_legal_hold_events"("organizationId", "recordClass", "recordId", "createdAt");

CREATE FUNCTION pharmacy_safe_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE='23514'; END $$;

CREATE TRIGGER pharmacy_retention_classes_append_only BEFORE UPDATE OR DELETE ON "pharmacy_retention_classes" FOR EACH ROW EXECUTE FUNCTION pharmacy_safe_append_only();
CREATE TRIGGER pharmacy_legal_hold_events_append_only BEFORE UPDATE OR DELETE ON "pharmacy_legal_hold_events" FOR EACH ROW EXECUTE FUNCTION pharmacy_safe_append_only();

CREATE FUNCTION pharmacy_safe_refuse_delete_under_hold() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE class_name "PharmacyRecordClass"; active_hold text;
BEGIN
  class_name := CASE TG_TABLE_NAME
    WHEN 'pharmacy_prescriptions' THEN 'PRESCRIPTION'
    WHEN 'pharmacy_controlled_register_entries' THEN 'CONTROLLED_REGISTER'
    WHEN 'pharmacy_sales' THEN 'FISCAL'
    WHEN 'audit_logs' THEN 'AUDIT'
  END;
  SELECT e."holdKey" INTO active_hold
    FROM "pharmacy_legal_hold_events" e
   WHERE e."organizationId"=OLD."organizationId" AND e."recordClass"=class_name AND e."recordId"=OLD."id"
     AND e."kind"=(SELECT latest."kind" FROM "pharmacy_legal_hold_events" latest
                    WHERE latest."organizationId"=e."organizationId" AND latest."holdKey"=e."holdKey"
                      AND latest."recordClass"=e."recordClass" AND latest."recordId"=e."recordId"
                    ORDER BY latest."createdAt" DESC, latest."id" DESC LIMIT 1)
     AND e."kind"='PLACED'
   ORDER BY e."holdKey" LIMIT 1;
  IF active_hold IS NOT NULL THEN
    RAISE EXCEPTION 'deletion refused: record is protected by legal hold %', active_hold USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER aa_pharmacy_prescriptions_legal_hold BEFORE DELETE ON "pharmacy_prescriptions" FOR EACH ROW EXECUTE FUNCTION pharmacy_safe_refuse_delete_under_hold();
CREATE TRIGGER aa_pharmacy_controlled_register_legal_hold BEFORE DELETE ON "pharmacy_controlled_register_entries" FOR EACH ROW EXECUTE FUNCTION pharmacy_safe_refuse_delete_under_hold();
CREATE TRIGGER aa_pharmacy_sales_legal_hold BEFORE DELETE ON "pharmacy_sales" FOR EACH ROW EXECUTE FUNCTION pharmacy_safe_refuse_delete_under_hold();
CREATE TRIGGER aa_pharmacy_audit_legal_hold BEFORE DELETE ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION pharmacy_safe_refuse_delete_under_hold();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_retention_classes','pharmacy_legal_hold_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.is_platform_admin'',true)=''true'' OR "organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),'''')) WITH CHECK (current_setting(''app.is_platform_admin'',true)=''true'' OR "organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),''''))', t);
  END LOOP;
END $$;
