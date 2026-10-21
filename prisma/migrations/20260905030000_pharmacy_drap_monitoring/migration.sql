-- ECO-01 + INV-08: manual/file DRAP notices, proposed prices and recall quarantine.
CREATE TYPE "PharmacyDrapNoticeKind" AS ENUM ('PRICE','RECALL');
CREATE TYPE "PharmacyDrapMatchStatus" AS ENUM ('MATCHED','AMBIGUOUS','NO_MATCH');
CREATE TYPE "PharmacyPriceChangeStatus" AS ENUM ('PROPOSED','CONFIRMED');

CREATE TABLE "pharmacy_drap_ingests" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "sourceReference" TEXT NOT NULL, "adapter" TEXT NOT NULL, "kind" "PharmacyDrapNoticeKind" NOT NULL,
  "payloadHash" TEXT NOT NULL, "matchStatus" "PharmacyDrapMatchStatus" NOT NULL, "matchDetails" JSONB NOT NULL,
  "recallNoticeId" TEXT, "ingestedById" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId","id"), UNIQUE ("organizationId","sourceReference","kind"), UNIQUE ("organizationId","recallNoticeId"),
  CHECK ("adapter" IN ('FILE','MANUAL')), CHECK (length(btrim("sourceReference")) > 0),
  CHECK (length(btrim("payloadHash")) > 0 AND length(btrim("ingestedById")) > 0),
  FOREIGN KEY ("organizationId","recallNoticeId") REFERENCES "pharmacy_recall_notices"("organizationId","id") ON DELETE RESTRICT
);

CREATE TABLE "pharmacy_price_change_proposals" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "ingestId" TEXT NOT NULL, "medicineId" TEXT NOT NULL, "currentPriceMinor" INTEGER NOT NULL,
  "notifiedPriceMinor" INTEGER NOT NULL, "effectiveDate" TIMESTAMP(3) NOT NULL,
  "status" "PharmacyPriceChangeStatus" NOT NULL DEFAULT 'PROPOSED', "confirmedById" TEXT, "confirmedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId","id"), UNIQUE ("organizationId","ingestId","medicineId"),
  CHECK ("currentPriceMinor" >= 0 AND "notifiedPriceMinor" >= 0),
  CHECK (("status"='CONFIRMED') = ("confirmedById" IS NOT NULL AND "confirmedAt" IS NOT NULL)),
  FOREIGN KEY ("organizationId","ingestId") REFERENCES "pharmacy_drap_ingests"("organizationId","id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId","medicineId") REFERENCES "pharmacy_medicines"("organizationId","id") ON DELETE RESTRICT
);

CREATE TABLE "pharmacy_recall_quarantine_actions" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "ingestId" TEXT NOT NULL, "recallNoticeId" TEXT NOT NULL, "branchId" TEXT NOT NULL,
  "inventoryLotId" TEXT NOT NULL, "stockLocationId" TEXT NOT NULL, "quantityUnits" INTEGER NOT NULL,
  "removedMovementId" TEXT NOT NULL, "heldMovementId" TEXT NOT NULL,
  "reversedById" TEXT, "reversedAt" TIMESTAMP(3), "reversalReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId","id"), UNIQUE ("organizationId","ingestId","inventoryLotId","stockLocationId"),
  CHECK ("quantityUnits" > 0),
  CHECK (("reversedAt" IS NULL AND "reversedById" IS NULL AND "reversalReason" IS NULL) OR
         ("reversedAt" IS NOT NULL AND length(btrim("reversedById")) > 0 AND length(btrim("reversalReason")) > 0)),
  FOREIGN KEY ("organizationId","ingestId") REFERENCES "pharmacy_drap_ingests"("organizationId","id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId","recallNoticeId") REFERENCES "pharmacy_recall_notices"("organizationId","id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId","branchId","inventoryLotId") REFERENCES "pharmacy_inventory_lots"("organizationId","branchId","id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId","removedMovementId") REFERENCES "pharmacy_stock_movements"("organizationId","id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId","heldMovementId") REFERENCES "pharmacy_stock_movements"("organizationId","id") ON DELETE RESTRICT
);
CREATE INDEX "pharmacy_recall_actions_org_branch_notice_idx" ON "pharmacy_recall_quarantine_actions"("organizationId","branchId","recallNoticeId");

CREATE TRIGGER pharmacy_drap_ingests_no_delete BEFORE DELETE ON "pharmacy_drap_ingests" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete();
CREATE TRIGGER pharmacy_price_proposals_no_delete BEFORE DELETE ON "pharmacy_price_change_proposals" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete();
CREATE TRIGGER pharmacy_recall_actions_no_delete BEFORE DELETE ON "pharmacy_recall_quarantine_actions" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_drap_ingests','pharmacy_price_change_proposals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.is_platform_admin'',true)=''true'' OR "organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),'''')) WITH CHECK (current_setting(''app.is_platform_admin'',true)=''true'' OR "organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),''''))',t);
  END LOOP;
END $$;
ALTER TABLE "pharmacy_recall_quarantine_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_recall_quarantine_actions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_branch_isolation ON "pharmacy_recall_quarantine_actions"
  USING (current_setting('app.is_platform_admin',true)='true' OR ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR "branchId"=current_setting('app.current_branch_id',true))))
  WITH CHECK (current_setting('app.is_platform_admin',true)='true' OR ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR "branchId"=current_setting('app.current_branch_id',true))));
