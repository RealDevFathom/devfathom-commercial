-- Sellable register balance excludes quarantine. Corrections stay new rows.
-- This migration does not drop FORCE ROW LEVEL SECURITY on
-- pharmacy_controlled_register_entries and does not drop the append-only
-- trigger pharmacy_controlled_register_entries_append_only.

CREATE OR REPLACE FUNCTION pharmacy_rx_reconcile_controlled_register() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual integer; movement record; lot_batch text; prior_branch text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."organizationId"||':'||NEW."branchId",0));
  IF EXISTS (
    SELECT 1 FROM "pharmacy_register_incidents"
    WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND "status"='OPEN'
  ) THEN
    RAISE EXCEPTION 'controlled dispensing blocked by open register incident' USING ERRCODE='23514';
  END IF;
  IF NEW."serial" <> COALESCE((
    SELECT max("serial")+1 FROM "pharmacy_controlled_register_entries"
    WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND "id"<>NEW."id"
  ),1) THEN
    RAISE EXCEPTION 'controlled register serial must be consecutive' USING ERRCODE='23514';
  END IF;

  IF NEW."entryKind" = 'CORRECTION' THEN
    SELECT "branchId" INTO prior_branch FROM "pharmacy_controlled_register_entries"
      WHERE "organizationId"=NEW."organizationId" AND "id"=NEW."correctsEntryId";
    IF prior_branch IS DISTINCT FROM NEW."branchId" THEN
      RAISE EXCEPTION 'correction must stay on the same branch register' USING ERRCODE='23514';
    END IF;
    -- The application compares the corrected balance with sellable stock and
    -- either requires a matching ADJUSTMENT or opens the incident. The trigger
    -- still refuses a second branch and a broken serial. It does not insert a
    -- second incident for the same correction row.
    RETURN NEW;
  END IF;

  SELECT * INTO movement FROM "pharmacy_stock_movements"
    WHERE "organizationId"=NEW."organizationId" AND "id"=NEW."stockMovementId";
  IF NEW."entryKind" = 'PURCHASE' THEN
    IF movement."kind"<>'RECEIPT' OR movement."branchId"<>NEW."branchId"
       OR movement."inventoryLotId"<>NEW."inventoryLotId"
       OR movement."quantityUnits"<>NEW."quantityCanonicalUnits" THEN
      RAISE EXCEPTION 'controlled register purchase does not match stock ledger movement' USING ERRCODE='23514';
    END IF;
  ELSE
    IF movement."kind"<>'SALE' OR movement."branchId"<>NEW."branchId"
       OR movement."inventoryLotId"<>NEW."inventoryLotId"
       OR movement."quantityUnits"<>-NEW."quantityCanonicalUnits" THEN
      RAISE EXCEPTION 'controlled register entry does not match stock ledger movement' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT b."batchNumber" INTO lot_batch
    FROM "pharmacy_inventory_lots" l
    JOIN "pharmacy_manufacturing_batches" b
      ON b."organizationId"=l."organizationId" AND b."id"=l."manufacturingBatchId"
    WHERE l."organizationId"=NEW."organizationId" AND l."id"=NEW."inventoryLotId";
  IF lot_batch IS DISTINCT FROM NEW."batchNumber" THEN
    RAISE EXCEPTION 'controlled register batch does not match stock lot' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(sum("onHandUnits"),0)::integer INTO actual FROM "pharmacy_stock_balances"
    WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId"
      AND "inventoryLotId"=NEW."inventoryLotId"
      AND "disposition" <> 'QUARANTINE';
  IF NEW."runningBalance"<>actual THEN
    INSERT INTO "pharmacy_register_incidents" ("id","organizationId","branchId","registerEntryId","expectedBalance","actualBalance")
    VALUES ('ri_'||md5(random()::text||clock_timestamp()::text),NEW."organizationId",NEW."branchId",NEW."id",NEW."runningBalance",actual);
  END IF;
  RETURN NEW;
END $$;

-- One open follow-up per emergency no-prescription supply. Rows are inserts;
-- closing them is a later workflow and is not granted here.
CREATE TABLE "pharmacy_emergency_rx_follow_ups" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "patientId" TEXT NOT NULL,
  "medicineId" TEXT NOT NULL,
  "saleLineId" TEXT NOT NULL,
  "quantityCanonicalUnits" INTEGER NOT NULL CHECK ("quantityCanonicalUnits" > 0),
  "recordedByUserId" TEXT NOT NULL,
  "witnessedByUserId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN' CHECK ("status" IN ('OPEN')),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_emergency_rx_follow_ups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pharmacy_emergency_rx_follow_ups_sale_line_key"
  ON "pharmacy_emergency_rx_follow_ups" ("organizationId", "saleLineId");
CREATE INDEX "pharmacy_emergency_rx_follow_ups_patient_medicine_idx"
  ON "pharmacy_emergency_rx_follow_ups" ("organizationId", "patientId", "medicineId", "createdAt");

ALTER TABLE "pharmacy_emergency_rx_follow_ups"
  ADD CONSTRAINT "pharmacy_emergency_rx_follow_ups_patient_fkey"
    FOREIGN KEY ("organizationId", "patientId")
    REFERENCES "pharmacy_patients" ("organizationId", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "pharmacy_emergency_rx_follow_ups_medicine_fkey"
    FOREIGN KEY ("organizationId", "medicineId")
    REFERENCES "pharmacy_medicines" ("organizationId", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "pharmacy_emergency_rx_follow_ups_sale_line_fkey"
    FOREIGN KEY ("organizationId", "saleLineId")
    REFERENCES "pharmacy_sale_lines" ("organizationId", "id") ON DELETE RESTRICT;

ALTER TABLE "pharmacy_emergency_rx_follow_ups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_emergency_rx_follow_ups" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pharmacy_emergency_rx_follow_ups"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );
