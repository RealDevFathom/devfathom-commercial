-- PH-RX — PRD §6.6 RX-03/RX-04/RX-05; §8A invariants 10, 12 and 14.
CREATE TYPE "PharmacyReviewDecisionKind" AS ENUM ('VERIFY','CLARIFY','REFUSE','OVERRIDE','COUNSEL','SIGN');
CREATE TYPE "PharmacyRegisterIncidentStatus" AS ENUM ('OPEN','APPROVED');

CREATE TABLE "pharmacy_pharmacist_review_items" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "prescriptionLineId" TEXT NOT NULL, "saleLineId" TEXT NOT NULL, "requestedByUserId" TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId","id"), UNIQUE ("organizationId","saleLineId"),
  FOREIGN KEY ("organizationId","prescriptionLineId") REFERENCES "pharmacy_prescription_lines"("organizationId","id") ON DELETE RESTRICT
);
CREATE TABLE "pharmacy_pharmacist_review_decisions" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "reviewItemId" TEXT NOT NULL, "kind" "PharmacyReviewDecisionKind" NOT NULL,
  "actorUserId" TEXT NOT NULL, "reason" TEXT, "signedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId","id"),
  FOREIGN KEY ("organizationId","reviewItemId") REFERENCES "pharmacy_pharmacist_review_items"("organizationId","id") ON DELETE RESTRICT,
  CHECK (("kind"='SIGN' AND "signedAt" IS NOT NULL) OR ("kind"<>'SIGN' AND "signedAt" IS NULL)),
  CHECK ("kind"<>'OVERRIDE' OR length(btrim(COALESCE("reason",''))) > 0)
);
CREATE INDEX "pharmacy_review_decisions_item_idx" ON "pharmacy_pharmacist_review_decisions"("organizationId","reviewItemId","createdAt");

CREATE TABLE "pharmacy_substitution_records" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "prescriptionLineId" TEXT NOT NULL, "saleLineId" TEXT NOT NULL,
  "prescribedPresentationId" TEXT NOT NULL, "suppliedPresentationId" TEXT NOT NULL,
  "equivalenceBasis" TEXT NOT NULL, "actorUserId" TEXT NOT NULL,
  "patientCommunication" TEXT NOT NULL, "jurisdictionRuleRef" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId","id"), UNIQUE ("organizationId","saleLineId"),
  FOREIGN KEY ("organizationId","prescriptionLineId") REFERENCES "pharmacy_prescription_lines"("organizationId","id") ON DELETE RESTRICT,
  CHECK ("prescribedPresentationId" <> "suppliedPresentationId"),
  CHECK (length(btrim("equivalenceBasis"))>0 AND length(btrim("patientCommunication"))>0 AND length(btrim("jurisdictionRuleRef"))>0)
);

CREATE TABLE "pharmacy_controlled_register_entries" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "serial" INTEGER NOT NULL, "prescriptionId" TEXT NOT NULL,
  "prescriptionLineId" TEXT NOT NULL, "patientId" TEXT NOT NULL, "prescriberId" TEXT NOT NULL,
  "inventoryLotId" TEXT NOT NULL, "stockMovementId" TEXT NOT NULL, "batchNumber" TEXT NOT NULL,
  "quantityCanonicalUnits" INTEGER NOT NULL CHECK ("quantityCanonicalUnits">0), "runningBalance" INTEGER NOT NULL CHECK ("runningBalance">=0),
  "recordedByUserId" TEXT NOT NULL, "witnessedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId","id"), UNIQUE ("organizationId","branchId","serial"), UNIQUE ("organizationId","stockMovementId"),
  FOREIGN KEY ("organizationId","prescriptionId") REFERENCES "pharmacy_prescriptions"("organizationId","id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId","prescriptionLineId") REFERENCES "pharmacy_prescription_lines"("organizationId","id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId","patientId") REFERENCES "pharmacy_patients"("organizationId","id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId","prescriberId") REFERENCES "pharmacy_prescribers"("organizationId","id") ON DELETE RESTRICT,
  CHECK ("recordedByUserId" <> "witnessedByUserId")
);
CREATE INDEX "pharmacy_controlled_register_lot_idx" ON "pharmacy_controlled_register_entries"("organizationId","branchId","inventoryLotId","createdAt");

CREATE TABLE "pharmacy_register_incidents" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "registerEntryId" TEXT NOT NULL, "expectedBalance" INTEGER NOT NULL,
  "actualBalance" INTEGER NOT NULL, "status" "PharmacyRegisterIncidentStatus" NOT NULL DEFAULT 'OPEN',
  "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId","id"),
  FOREIGN KEY ("organizationId","registerEntryId") REFERENCES "pharmacy_controlled_register_entries"("organizationId","id") ON DELETE RESTRICT
);
CREATE INDEX "pharmacy_register_incidents_open_idx" ON "pharmacy_register_incidents"("organizationId","branchId","status");
CREATE TABLE "pharmacy_register_incident_approvals" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "incidentId" TEXT NOT NULL, "approvedByUserId" TEXT NOT NULL, "reason" TEXT NOT NULL,
  "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId","id"), UNIQUE ("organizationId","incidentId"),
  FOREIGN KEY ("organizationId","incidentId") REFERENCES "pharmacy_register_incidents"("organizationId","id") ON DELETE RESTRICT,
  CHECK (length(btrim("reason"))>0)
);

CREATE FUNCTION pharmacy_rx_reject_review_self_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE requester text;
BEGIN
  SELECT "requestedByUserId" INTO requester FROM "pharmacy_pharmacist_review_items"
   WHERE "organizationId"=NEW."organizationId" AND "id"=NEW."reviewItemId";
  IF NEW."actorUserId"=requester THEN RAISE EXCEPTION 'requesting cashier cannot approve pharmacist-required line' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_review_no_self_approval BEFORE INSERT ON "pharmacy_pharmacist_review_decisions" FOR EACH ROW EXECUTE FUNCTION pharmacy_rx_reject_review_self_approval();

CREATE FUNCTION pharmacy_rx_reconcile_controlled_register() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual integer; movement record; lot_batch text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."organizationId"||':'||NEW."branchId",0));
  IF EXISTS (SELECT 1 FROM "pharmacy_register_incidents" WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND "status"='OPEN') THEN
    RAISE EXCEPTION 'controlled dispensing blocked by open register incident' USING ERRCODE='23514';
  END IF;
  IF NEW."serial" <> COALESCE((SELECT max("serial")+1 FROM "pharmacy_controlled_register_entries" WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId"),1) THEN
    RAISE EXCEPTION 'controlled register serial must be consecutive' USING ERRCODE='23514';
  END IF;
  SELECT * INTO movement FROM "pharmacy_stock_movements" WHERE "organizationId"=NEW."organizationId" AND "id"=NEW."stockMovementId";
  IF movement."kind"<>'SALE' OR movement."branchId"<>NEW."branchId" OR movement."inventoryLotId"<>NEW."inventoryLotId" OR movement."quantityUnits"<>-NEW."quantityCanonicalUnits" THEN
    RAISE EXCEPTION 'controlled register entry does not match stock ledger movement' USING ERRCODE='23514';
  END IF;
  SELECT b."batchNumber" INTO lot_batch FROM "pharmacy_inventory_lots" l JOIN "pharmacy_manufacturing_batches" b ON b."organizationId"=l."organizationId" AND b."id"=l."manufacturingBatchId" WHERE l."organizationId"=NEW."organizationId" AND l."id"=NEW."inventoryLotId";
  IF lot_batch IS DISTINCT FROM NEW."batchNumber" THEN RAISE EXCEPTION 'controlled register batch does not match stock lot' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(sum("onHandUnits"),0)::integer INTO actual FROM "pharmacy_stock_balances" WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND "inventoryLotId"=NEW."inventoryLotId";
  IF NEW."runningBalance"<>actual THEN
    INSERT INTO "pharmacy_register_incidents" ("id","organizationId","branchId","registerEntryId","expectedBalance","actualBalance")
    VALUES ('ri_'||md5(random()::text||clock_timestamp()::text),NEW."organizationId",NEW."branchId",NEW."id",NEW."runningBalance",actual);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_controlled_register_reconcile AFTER INSERT ON "pharmacy_controlled_register_entries" FOR EACH ROW EXECUTE FUNCTION pharmacy_rx_reconcile_controlled_register();

CREATE FUNCTION pharmacy_rx_approve_register_incident() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN UPDATE "pharmacy_register_incidents" SET "status"='APPROVED' WHERE "organizationId"=NEW."organizationId" AND "id"=NEW."incidentId" AND "status"='OPEN'; RETURN NEW; END $$;
CREATE TRIGGER pharmacy_register_incident_approve AFTER INSERT ON "pharmacy_register_incident_approvals" FOR EACH ROW EXECUTE FUNCTION pharmacy_rx_approve_register_incident();

CREATE FUNCTION pharmacy_rx_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only',TG_TABLE_NAME USING ERRCODE='23514'; END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_pharmacist_review_items','pharmacy_pharmacist_review_decisions','pharmacy_substitution_records','pharmacy_controlled_register_entries','pharmacy_register_incident_approvals'] LOOP
    EXECUTE format('CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION pharmacy_rx_append_only()',t,t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['pharmacy_pharmacist_review_items','pharmacy_pharmacist_review_decisions','pharmacy_substitution_records','pharmacy_controlled_register_entries','pharmacy_register_incidents','pharmacy_register_incident_approvals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.is_platform_admin'',true)=''true'' OR "organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),'''')) WITH CHECK (current_setting(''app.is_platform_admin'',true)=''true'' OR "organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),''''))',t);
  END LOOP;
END $$;
