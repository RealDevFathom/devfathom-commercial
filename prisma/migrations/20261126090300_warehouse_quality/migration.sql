BEGIN;
ALTER TABLE pharmacy_medicines ADD COLUMN "minimumStorageTemperatureC" double precision,
  ADD COLUMN "maximumStorageTemperatureC" double precision,
  ADD CONSTRAINT pharmacy_wh_labelled_range CHECK (
    num_nonnulls("minimumStorageTemperatureC","maximumStorageTemperatureC")=0 OR
    (num_nonnulls("minimumStorageTemperatureC","maximumStorageTemperatureC")=2
     AND "minimumStorageTemperatureC">=-100 AND "maximumStorageTemperatureC"<=100
     AND "minimumStorageTemperatureC"<="maximumStorageTemperatureC"))
;
CREATE TABLE pharmacy_warehouse_transport_evidence (
  id text PRIMARY KEY, "organizationId" text NOT NULL DEFAULT current_setting('app.current_organization_id',true),
  "branchId" text NOT NULL, "transferId" text NOT NULL, "transferLineId" text,
  phase text NOT NULL CHECK (phase IN ('DISPATCH','RECEIPT')), "minimumC" double precision, "maximumC" double precision,
  "evidenceRef" text, "receivedUnits" int, "damagedUnits" int, "heldUnits" int, "shortageUnits" int, "destinationLotId" text,
  "productScan" text, "lotScan" text, "binScan" text, "requestKey" text NOT NULL, "actorId" text NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pharmacy_wh_transport_request_key UNIQUE ("organizationId","branchId",phase,"requestKey"),
  FOREIGN KEY ("organizationId","transferId") REFERENCES pharmacy_interbranch_transfers("organizationId",id),
  FOREIGN KEY ("organizationId","branchId") REFERENCES pharmacy_branches("organizationId",id),
  FOREIGN KEY ("transferLineId") REFERENCES pharmacy_interbranch_transfer_lines(id),
  FOREIGN KEY ("organizationId","branchId","destinationLotId") REFERENCES pharmacy_inventory_lots("organizationId","branchId",id),
  CHECK (num_nonnulls("minimumC","maximumC") IN (0,2) AND "minimumC" <= "maximumC")
);
CREATE TRIGGER pharmacy_wh_transport_append_only BEFORE UPDATE OR DELETE ON pharmacy_warehouse_transport_evidence
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
CREATE INDEX pharmacy_wh_transport_history ON pharmacy_warehouse_transport_evidence("organizationId","transferId",phase,"createdAt");
CREATE TABLE pharmacy_warehouse_quality_incidents (
  id text PRIMARY KEY, "organizationId" text NOT NULL DEFAULT current_setting('app.current_organization_id',true), "branchId" text NOT NULL,
  "inventoryLotId" text NOT NULL, "stockLocationId" text NOT NULL, "transferId" text, "quantityUnits" int NOT NULL CHECK ("quantityUnits">0),
  "quarantineUnits" int NOT NULL DEFAULT 0 CHECK ("quarantineUnits" BETWEEN 0 AND "quantityUnits"), reason text NOT NULL, "sourceKey" text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RELEASE','RETURN','DISPOSE')), "createdById" text NOT NULL, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "supplierReturnLineId" text CONSTRAINT pharmacy_wh_return_line_key UNIQUE REFERENCES pharmacy_purchase_return_lines(id),
  "reviewedById" text, "reviewedAt" timestamp(3), "reviewEvidenceRef" text, "reviewReason" text,
  CONSTRAINT pharmacy_wh_incident_source UNIQUE ("organizationId","inventoryLotId","stockLocationId","sourceKey"),
  FOREIGN KEY ("organizationId","branchId","stockLocationId") REFERENCES pharmacy_stock_locations("organizationId","branchId",id),
  FOREIGN KEY ("organizationId","branchId","inventoryLotId") REFERENCES pharmacy_inventory_lots("organizationId","branchId",id),
  FOREIGN KEY ("organizationId","transferId") REFERENCES pharmacy_interbranch_transfers("organizationId",id)
);
CREATE INDEX pharmacy_wh_incident_queue ON pharmacy_warehouse_quality_incidents("organizationId","branchId",status,"createdAt");
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_warehouse_transport_evidence','pharmacy_warehouse_quality_incidents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($policy$CREATE POLICY tenant_branch_isolation ON %I
      USING (current_setting('app.is_platform_admin',true)='true' OR (
        "organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND
        (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR
         "branchId"=current_setting('app.current_branch_id',true))))
      WITH CHECK (current_setting('app.is_platform_admin',true)='true' OR (
        "organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND
        (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR
         "branchId"=current_setting('app.current_branch_id',true))))$policy$,t);
  END LOOP;
END $rls$;
COMMIT;
