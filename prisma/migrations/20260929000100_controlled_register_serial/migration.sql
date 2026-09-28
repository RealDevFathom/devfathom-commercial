-- Invariant: register serials are consecutive per tenant and branch.
-- This AFTER INSERT check must exclude NEW when finding the preceding serial.
-- Preserve dual control, append-only history, ledger reconciliation and incident blocking.
CREATE OR REPLACE FUNCTION pharmacy_rx_reconcile_controlled_register() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual integer; movement record; lot_batch text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."organizationId"||':'||NEW."branchId",0));
  IF EXISTS (SELECT 1 FROM "pharmacy_register_incidents" WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND "status"='OPEN') THEN
    RAISE EXCEPTION 'controlled dispensing blocked by open register incident' USING ERRCODE='23514';
  END IF;
  IF NEW."serial" <> COALESCE((SELECT max("serial")+1 FROM "pharmacy_controlled_register_entries" WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND "id"<>NEW."id"),1) THEN
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
