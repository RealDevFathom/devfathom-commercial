-- PH-INV INV-06/07/08(manual)/09: counts, inter-branch custody,
-- manual recalls/quarantine, and supplier-return reservations.
CREATE TYPE "PharmacyInventoryCountStatus" AS ENUM ('OPEN','AWAITING_COAUTH','APPROVED');
CREATE TYPE "PharmacyTransferStatus" AS ENUM ('ALLOCATED','APPROVED','DISPATCHED','PARTIALLY_RECEIVED','RECEIVED','EXCEPTION');
CREATE TYPE "PharmacyRecallStatus" AS ENUM ('OPEN','CLOSED');
CREATE TYPE "PharmacySupplierClaimStatus" AS ENUM ('RESERVED','RELEASED','SUBMITTED');

CREATE TABLE "pharmacy_inventory_counts" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "status" "PharmacyInventoryCountStatus" NOT NULL DEFAULT 'OPEN',
  "varianceThreshold" INTEGER NOT NULL, "createdById" TEXT NOT NULL, "approvedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "approvedAt" TIMESTAMP(3),
  UNIQUE ("organizationId","id"),
  CHECK ("varianceThreshold" >= 0 AND length(btrim("branchId")) > 0 AND length(btrim("createdById")) > 0),
  CHECK (("status" = 'APPROVED') = ("approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL))
);
CREATE INDEX "pharmacy_inventory_counts_org_branch_created_idx" ON "pharmacy_inventory_counts"("organizationId","branchId","createdAt");

CREATE TABLE "pharmacy_inventory_count_lines" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "countId" TEXT NOT NULL, "branchId" TEXT NOT NULL, "inventoryLotId" TEXT NOT NULL, "stockLocationId" TEXT NOT NULL,
  "expectedUnits" INTEGER NOT NULL, "expectedSealedPacks" INTEGER NOT NULL, "expectedLooseUnits" INTEGER NOT NULL,
  "countedSealedPacks" INTEGER, "countedLooseUnits" INTEGER, "countedUnits" INTEGER, "varianceUnits" INTEGER,
  FOREIGN KEY ("organizationId","countId") REFERENCES "pharmacy_inventory_counts"("organizationId","id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId","branchId","inventoryLotId") REFERENCES "pharmacy_inventory_lots"("organizationId","branchId","id") ON DELETE RESTRICT,
  UNIQUE ("organizationId","countId","inventoryLotId","stockLocationId"),
  CHECK ("expectedUnits" >= 0 AND "expectedSealedPacks" >= 0 AND "expectedLooseUnits" >= 0),
  CHECK (("countedUnits" IS NULL AND "varianceUnits" IS NULL) OR ("countedUnits" >= 0 AND "countedSealedPacks" >= 0 AND "countedLooseUnits" >= 0 AND "varianceUnits" = "countedUnits" - "expectedUnits"))
);
CREATE INDEX "pharmacy_inventory_count_lines_org_branch_idx" ON "pharmacy_inventory_count_lines"("organizationId","branchId");

CREATE TABLE "pharmacy_interbranch_transfers" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "fromBranchId" TEXT NOT NULL, "toBranchId" TEXT NOT NULL, "status" "PharmacyTransferStatus" NOT NULL DEFAULT 'ALLOCATED',
  "allocatedById" TEXT NOT NULL, "approvedById" TEXT, "dispatchedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "dispatchedAt" TIMESTAMP(3), "receivedAt" TIMESTAMP(3),
  UNIQUE ("organizationId","id"),
  CHECK ("fromBranchId" <> "toBranchId" AND length(btrim("allocatedById")) > 0)
);
CREATE INDEX "pharmacy_interbranch_transfers_from_idx" ON "pharmacy_interbranch_transfers"("organizationId","fromBranchId","status");
CREATE INDEX "pharmacy_interbranch_transfers_to_idx" ON "pharmacy_interbranch_transfers"("organizationId","toBranchId","status");

CREATE TABLE "pharmacy_interbranch_transfer_lines" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "transferId" TEXT NOT NULL, "sourceBranchId" TEXT NOT NULL, "sourceLotId" TEXT NOT NULL,
  "sourceStockLocationId" TEXT NOT NULL, "destinationStockLocationId" TEXT NOT NULL,
  "quantityUnits" INTEGER NOT NULL, "receivedUnits" INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY ("organizationId","transferId") REFERENCES "pharmacy_interbranch_transfers"("organizationId","id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId","sourceBranchId","sourceLotId") REFERENCES "pharmacy_inventory_lots"("organizationId","branchId","id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId","sourceStockLocationId") REFERENCES "pharmacy_stock_locations"("organizationId","id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId","destinationStockLocationId") REFERENCES "pharmacy_stock_locations"("organizationId","id") ON DELETE RESTRICT,
  UNIQUE ("organizationId","transferId","sourceLotId","sourceStockLocationId"),
  CHECK ("quantityUnits" > 0 AND "receivedUnits" >= 0 AND "receivedUnits" <= "quantityUnits")
);

CREATE TABLE "pharmacy_recall_notices" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "batchId" TEXT, "medicineId" TEXT, "reference" TEXT NOT NULL, "reason" TEXT NOT NULL,
  "status" "PharmacyRecallStatus" NOT NULL DEFAULT 'OPEN', "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "closedById" TEXT, "closedAt" TIMESTAMP(3),
  UNIQUE ("organizationId","id"), UNIQUE ("organizationId","reference"),
  CHECK (("batchId" IS NULL) <> ("medicineId" IS NULL)),
  CHECK (length(btrim("reference")) > 0 AND length(btrim("reason")) > 0 AND length(btrim("createdById")) > 0),
  CHECK (("status" = 'CLOSED') = ("closedById" IS NOT NULL AND "closedAt" IS NOT NULL))
);
CREATE INDEX "pharmacy_recall_notices_org_status_idx" ON "pharmacy_recall_notices"("organizationId","status");

CREATE TABLE "pharmacy_recall_acknowledgements" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "recallNoticeId" TEXT NOT NULL, "branchId" TEXT NOT NULL, "actorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("organizationId","recallNoticeId") REFERENCES "pharmacy_recall_notices"("organizationId","id") ON DELETE RESTRICT,
  UNIQUE ("organizationId","recallNoticeId","branchId"), CHECK (length(btrim("actorId")) > 0)
);

CREATE TABLE "pharmacy_custody_records" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "movementId" TEXT NOT NULL, "actorId" TEXT NOT NULL, "witnessId" TEXT NOT NULL,
  "reason" TEXT NOT NULL, "evidenceRef" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId","movementId"),
  FOREIGN KEY ("organizationId","movementId") REFERENCES "pharmacy_stock_movements"("organizationId","id") ON DELETE RESTRICT,
  CHECK ("actorId" <> "witnessId" AND length(btrim("reason")) > 0 AND length(btrim("evidenceRef")) > 0)
);
CREATE INDEX "pharmacy_custody_records_org_branch_created_idx" ON "pharmacy_custody_records"("organizationId","branchId","createdAt");

CREATE TABLE "pharmacy_supplier_claims" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "inventoryLotId" TEXT NOT NULL, "reservedUnits" INTEGER NOT NULL, "returnBy" TIMESTAMP(3) NOT NULL,
  "status" "PharmacySupplierClaimStatus" NOT NULL DEFAULT 'RESERVED', "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("organizationId","branchId","inventoryLotId") REFERENCES "pharmacy_inventory_lots"("organizationId","branchId","id") ON DELETE RESTRICT,
  CHECK ("reservedUnits" > 0 AND length(btrim("createdById")) > 0)
);
CREATE INDEX "pharmacy_supplier_claims_org_branch_return_idx" ON "pharmacy_supplier_claims"("organizationId","branchId","returnBy");

-- Append-only evidence tables; lifecycle roots may advance status but cannot be deleted.
CREATE TRIGGER pharmacy_inventory_count_lines_append_only BEFORE UPDATE OR DELETE ON "pharmacy_inventory_count_lines" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
CREATE TRIGGER pharmacy_custody_records_append_only BEFORE UPDATE OR DELETE ON "pharmacy_custody_records" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
CREATE TRIGGER pharmacy_recall_ack_append_only BEFORE UPDATE OR DELETE ON "pharmacy_recall_acknowledgements" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
CREATE TRIGGER pharmacy_inventory_counts_no_delete BEFORE DELETE ON "pharmacy_inventory_counts" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete();
CREATE TRIGGER pharmacy_transfers_no_delete BEFORE DELETE ON "pharmacy_interbranch_transfers" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete();
CREATE TRIGGER pharmacy_transfer_lines_no_delete BEFORE DELETE ON "pharmacy_interbranch_transfer_lines" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete();
CREATE TRIGGER pharmacy_recall_notices_no_delete BEFORE DELETE ON "pharmacy_recall_notices" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete();
CREATE TRIGGER pharmacy_supplier_claims_no_delete BEFORE DELETE ON "pharmacy_supplier_claims" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete();

-- Tenant and optional branch narrowing. Transfer roots are visible to either participating branch.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_inventory_counts','pharmacy_inventory_count_lines','pharmacy_custody_records','pharmacy_supplier_claims'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_branch_isolation ON %I USING (current_setting(''app.is_platform_admin'',true) = ''true'' OR ("organizationId" = NULLIF(current_setting(''app.current_organization_id'',true),'''') AND (NULLIF(current_setting(''app.current_branch_id'',true),'''') IS NULL OR "branchId" = current_setting(''app.current_branch_id'',true)))) WITH CHECK (current_setting(''app.is_platform_admin'',true) = ''true'' OR ("organizationId" = NULLIF(current_setting(''app.current_organization_id'',true),'''') AND (NULLIF(current_setting(''app.current_branch_id'',true),'''') IS NULL OR "branchId" = current_setting(''app.current_branch_id'',true))))',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['pharmacy_recall_notices','pharmacy_recall_acknowledgements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.is_platform_admin'',true) = ''true'' OR "organizationId" = NULLIF(current_setting(''app.current_organization_id'',true),'''')) WITH CHECK (current_setting(''app.is_platform_admin'',true) = ''true'' OR "organizationId" = NULLIF(current_setting(''app.current_organization_id'',true),''''))',t);
  END LOOP;
END $$;
ALTER TABLE "pharmacy_interbranch_transfers" ENABLE ROW LEVEL SECURITY; ALTER TABLE "pharmacy_interbranch_transfers" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_transfer_branch_isolation ON "pharmacy_interbranch_transfers" USING (current_setting('app.is_platform_admin',true)='true' OR ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR current_setting('app.current_branch_id',true) IN ("fromBranchId","toBranchId")))) WITH CHECK (current_setting('app.is_platform_admin',true)='true' OR ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR current_setting('app.current_branch_id',true) IN ("fromBranchId","toBranchId"))));
ALTER TABLE "pharmacy_interbranch_transfer_lines" ENABLE ROW LEVEL SECURITY; ALTER TABLE "pharmacy_interbranch_transfer_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_transfer_line_isolation ON "pharmacy_interbranch_transfer_lines" USING (current_setting('app.is_platform_admin',true)='true' OR ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND EXISTS (SELECT 1 FROM "pharmacy_interbranch_transfers" t WHERE t."organizationId"="pharmacy_interbranch_transfer_lines"."organizationId" AND t.id="pharmacy_interbranch_transfer_lines"."transferId"))) WITH CHECK (current_setting('app.is_platform_admin',true)='true' OR ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND EXISTS (SELECT 1 FROM "pharmacy_interbranch_transfers" t WHERE t."organizationId"="pharmacy_interbranch_transfer_lines"."organizationId" AND t.id="pharmacy_interbranch_transfer_lines"."transferId")));
