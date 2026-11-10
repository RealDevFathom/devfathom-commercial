BEGIN;

-- Zero is reserved for a movement-backed purchase reversal. The trigger below
-- checks the original kind and the exact compensating receipt movement.
ALTER TABLE "pharmacy_controlled_register_entries"
  DROP CONSTRAINT IF EXISTS "pharmacy_controlled_register_entri_quantityCanonicalUnits_check";
ALTER TABLE "pharmacy_controlled_register_entries"
  ADD CONSTRAINT "pharmacy_controlled_register_entri_quantityCanonicalUnits_check"
  CHECK ("quantityCanonicalUnits" > 0 OR (
    "entryKind" = 'CORRECTION' AND "quantityCanonicalUnits" = 0
    AND "restorationMovementId" IS NOT NULL
  ));

CREATE OR REPLACE FUNCTION pharmacy_rx_reconcile_controlled_register() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual integer; movement record; lot_batch text; original record; previous_balance bigint; derived_delta bigint; restored bigint;
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
    SELECT * INTO original FROM "pharmacy_controlled_register_entries"
      WHERE "organizationId"=NEW."organizationId" AND "id"=NEW."correctsEntryId";
    IF NOT FOUND OR original."entryKind" = 'CORRECTION'
       OR original."branchId" IS DISTINCT FROM NEW."branchId"
       OR original."inventoryLotId" IS DISTINCT FROM NEW."inventoryLotId"
       OR original."medicineId" IS DISTINCT FROM NEW."medicineId"
       OR original."batchNumber" IS DISTINCT FROM NEW."batchNumber" THEN
      RAISE EXCEPTION 'correction must reference an original entry in the same lot register' USING ERRCODE='23514';
    END IF;
    IF NEW."restorationMovementId" IS NULL THEN
      IF EXISTS (SELECT 1 FROM "pharmacy_controlled_register_entries"
        WHERE "organizationId"=NEW."organizationId" AND "correctsEntryId"=original."id" AND "id"<>NEW."id") THEN
        RAISE EXCEPTION 'entry already corrected' USING ERRCODE='23514';
      END IF;
      derived_delta := CASE WHEN original."entryKind"='SALE'
        THEN original."quantityCanonicalUnits"::bigint - NEW."quantityCanonicalUnits"
        ELSE NEW."quantityCanonicalUnits"::bigint - original."quantityCanonicalUnits" END;
      IF NEW."quantityCanonicalUnits" <= 0 OR abs(derived_delta)>original."quantityCanonicalUnits" THEN
        RAISE EXCEPTION 'correction quantity exceeds original cap' USING ERRCODE='23514';
      END IF;
      -- The database derives the delta too; callers cannot supply an arbitrary change.
      IF NEW."balanceDelta"::bigint IS DISTINCT FROM derived_delta THEN
        RAISE EXCEPTION 'correction delta must be derived from original quantity' USING ERRCODE='23514';
      END IF;
    ELSIF original."entryKind" = 'PURCHASE' THEN
      SELECT * INTO movement FROM "pharmacy_stock_movements"
        WHERE "organizationId"=NEW."organizationId" AND "id"=NEW."restorationMovementId";
      IF NOT FOUND OR movement."kind" IS DISTINCT FROM 'ADJUSTMENT'
         OR movement."branchId" IS DISTINCT FROM NEW."branchId"
         OR movement."inventoryLotId" IS DISTINCT FROM NEW."inventoryLotId"
         OR movement."reversesMovementId" IS DISTINCT FROM original."stockMovementId"
         OR movement."disposition" = 'QUARANTINE'
         OR movement."quantityUnits"::bigint IS DISTINCT FROM -original."quantityCanonicalUnits"::bigint
         OR NEW."quantityCanonicalUnits" <> 0
         OR NEW."balanceDelta" IS DISTINCT FROM movement."quantityUnits" THEN
        RAISE EXCEPTION 'purchase reversal must match a compensating receipt movement' USING ERRCODE='23514';
      END IF;
    ELSE
      SELECT * INTO movement FROM "pharmacy_stock_movements"
        WHERE "organizationId"=NEW."organizationId" AND "id"=NEW."restorationMovementId";
      IF NOT FOUND OR original."entryKind" <> 'SALE'
         OR movement."branchId" IS DISTINCT FROM NEW."branchId"
         OR movement."inventoryLotId" IS DISTINCT FROM NEW."inventoryLotId"
         OR movement."quantityUnits" IS DISTINCT FROM NEW."quantityCanonicalUnits"
         OR movement."quantityUnits" <= 0
         OR NOT COALESCE((
           (movement."kind"='ADJUSTMENT' AND movement."reversesMovementId"=original."stockMovementId")
           OR (movement."kind"='RETURN' AND EXISTS (
             SELECT 1 FROM "pharmacy_sale_return_lines" r
             JOIN "pharmacy_sale_line_allocations" a ON a."organizationId"=r."organizationId"
               AND a."saleLineId"=r."saleLineId" AND a."inventoryLotId"=r."inventoryLotId"
             WHERE r."organizationId"=NEW."organizationId" AND r."stockMovementId"=movement."id"
               AND a."stockMovementId"=original."stockMovementId"
           ))
         ), false) THEN
        RAISE EXCEPTION 'restoration must match a compensating stock movement' USING ERRCODE='23514';
      END IF;
      SELECT COALESCE(sum("quantityCanonicalUnits"),0) INTO restored
        FROM "pharmacy_controlled_register_entries"
        WHERE "organizationId"=NEW."organizationId" AND "correctsEntryId"=original."id"
          AND "restorationMovementId" IS NOT NULL AND "id"<>NEW."id";
      IF restored + NEW."quantityCanonicalUnits" > original."quantityCanonicalUnits" THEN
        RAISE EXCEPTION 'restoration exceeds original quantity' USING ERRCODE='23514';
      END IF;
      IF NEW."balanceDelta" IS DISTINCT FROM (CASE WHEN movement."disposition"='QUARANTINE' THEN 0 ELSE movement."quantityUnits" END) THEN
        RAISE EXCEPTION 'restoration delta must match sellable movement' USING ERRCODE='23514';
      END IF;
    END IF;
    SELECT "runningBalance" INTO previous_balance FROM "pharmacy_controlled_register_entries"
      WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId"
        AND "inventoryLotId"=NEW."inventoryLotId" AND "medicineId"=NEW."medicineId" AND "id"<>NEW."id"
      ORDER BY "serial" DESC LIMIT 1;
    SELECT COALESCE(sum("onHandUnits"),0) INTO actual FROM "pharmacy_stock_balances"
      WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId"
        AND "inventoryLotId"=NEW."inventoryLotId" AND "disposition" <> 'QUARANTINE';
    IF NEW."runningBalance"::bigint IS DISTINCT FROM previous_balance + NEW."balanceDelta"
       OR NEW."runningBalance" IS DISTINCT FROM actual THEN
      RAISE EXCEPTION 'correction balance must equal sellable on-hand and prior balance plus delta' USING ERRCODE='23514';
    END IF;
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

COMMIT;
