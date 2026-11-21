BEGIN;

ALTER TYPE "PharmacyControlledRegisterKind" ADD VALUE IF NOT EXISTS 'RETURN_TO_SUPPLIER';

ALTER TABLE pharmacy_controlled_register_entries
  ADD COLUMN IF NOT EXISTS "sourcePurchaseEntryId" text,
  ADD COLUMN IF NOT EXISTS "supplierReturnLineId" text;

-- PostgreSQL 16 permits use of the new enum literal after this transaction
-- commits. Compare the enum label as text in the two immediate CHECKs.
DO $constraints$
DECLARE register_table regclass := 'pharmacy_controlled_register_entries'::regclass;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid = register_table AND conname = 'pharmacy_register_return_purchase_fk') THEN
    ALTER TABLE pharmacy_controlled_register_entries
      ADD CONSTRAINT pharmacy_register_return_purchase_fk FOREIGN KEY ("organizationId", "sourcePurchaseEntryId")
        REFERENCES pharmacy_controlled_register_entries ("organizationId", id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid = register_table AND conname = 'pharmacy_register_return_line_fk') THEN
    ALTER TABLE pharmacy_controlled_register_entries
      ADD CONSTRAINT pharmacy_register_return_line_fk FOREIGN KEY ("organizationId", "supplierReturnLineId")
        REFERENCES pharmacy_purchase_return_lines ("organizationId", id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid = register_table AND conname = 'pharmacy_register_return_line_once') THEN
    ALTER TABLE pharmacy_controlled_register_entries
      ADD CONSTRAINT pharmacy_register_return_line_once UNIQUE ("organizationId", "supplierReturnLineId");
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid = register_table AND conname = 'pharmacy_register_return_source') THEN
    ALTER TABLE pharmacy_controlled_register_entries
      ADD CONSTRAINT pharmacy_register_return_source CHECK (
        ("entryKind"::text = 'RETURN_TO_SUPPLIER') = ("sourcePurchaseEntryId" IS NOT NULL) AND
        ("entryKind"::text = 'RETURN_TO_SUPPLIER') = ("supplierReturnLineId" IS NOT NULL)
      );
  END IF;
END $constraints$;

ALTER TABLE pharmacy_controlled_register_entries DROP CONSTRAINT IF EXISTS pharmacy_controlled_register_kind_shape;
ALTER TABLE pharmacy_controlled_register_entries
  ADD CONSTRAINT "pharmacy_controlled_register_kind_shape" CHECK (
        (
          "entryKind" = 'SALE'
          AND "stockMovementId" IS NOT NULL
          AND "patientId" IS NOT NULL
          AND (
            (
              "emergency" = false
              AND "prescriptionId" IS NOT NULL
              AND "prescriptionLineId" IS NOT NULL
              AND "prescriberId" IS NOT NULL
            )
            OR (
              "emergency" = true
              AND length(btrim(COALESCE("prescriberName", ''))) > 0
            )
          )
        )
        OR (
          "entryKind" = 'SALE'
          AND "stockMovementId" IS NOT NULL
          AND "emergency" = false
          AND COALESCE("signatureRef", '') LIKE 'pharmacist-check-off:%'
        )
        OR (
          "entryKind" = 'PURCHASE'
          AND "stockMovementId" IS NOT NULL
          AND "prescriptionId" IS NULL
          AND length(btrim(COALESCE("counterpartyName", ''))) > 0
        )
        OR (
          "entryKind" = 'CORRECTION'
          AND "correctsEntryId" IS NOT NULL
          AND "stockMovementId" IS NULL
          AND length(btrim(COALESCE("correctionReason", ''))) > 0
        )
        OR (
          "entryKind"::text = 'RETURN_TO_SUPPLIER' AND "stockMovementId" IS NOT NULL
          AND "recordedByUserId" <> "witnessedByUserId" AND (COALESCE("signatureRef", '') LIKE 'pin:%' OR COALESCE("signatureRef", '') LIKE 'authenticator:%')
          AND length(btrim(COALESCE("counterpartyName", ''))) > 0
          AND "correctsEntryId" IS NULL AND "restorationMovementId" IS NULL
          AND "prescriptionId" IS NULL AND "patientId" IS NULL AND NOT emergency
        )
      );

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
    IF NOT FOUND OR original."entryKind" NOT IN ('PURCHASE', 'SALE')
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
        AND "inventoryLotId"=NEW."inventoryLotId" AND "disposition" NOT IN ('QUARANTINE', 'RETURN_TO_SUPPLIER');
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
  ELSIF NEW."entryKind" = 'RETURN_TO_SUPPLIER' THEN
    -- Follow both sides to the receipt and supplier. Lot or supplier names alone
    -- cannot prove where a purchase or dispatch came from.
    IF NOT EXISTS (
      SELECT 1 FROM pharmacy_controlled_register_entries purchase
      JOIN pharmacy_stock_movements receipt ON receipt."organizationId" = purchase."organizationId"
        AND receipt.id = purchase."stockMovementId"
      JOIN pharmacy_goods_receipt_lines grl ON grl."organizationId" = purchase."organizationId"
        AND receipt."idempotencyKey" = 'pharmacy-receipt:' || grl.id || ':accepted'
      JOIN pharmacy_goods_receipts gr ON gr."organizationId" = grl."organizationId" AND gr.id = grl."goodsReceiptId"
      JOIN pharmacy_purchase_return_lines line ON line."organizationId" = gr."organizationId"
        AND line.id = NEW."supplierReturnLineId"
      JOIN pharmacy_purchase_returns doc ON doc."organizationId" = line."organizationId" AND doc.id = line."purchaseReturnId"
      JOIN pharmacy_suppliers supplier ON supplier."organizationId" = doc."organizationId" AND supplier.id = doc."supplierId"
      WHERE purchase."organizationId" = NEW."organizationId" AND purchase.id = NEW."sourcePurchaseEntryId"
        AND purchase."entryKind" = 'PURCHASE' AND gr.status = 'POSTED' AND doc.status = 'SUBMITTED'
        AND gr."supplierId" = doc."supplierId" AND NEW."counterpartyName" = supplier.name
        AND NEW."branchId" = purchase."branchId" AND doc."branchId" = NEW."branchId"
        AND purchase."medicineId" = NEW."medicineId" AND purchase."inventoryLotId" = NEW."inventoryLotId"
        AND line."inventoryLotId" = NEW."inventoryLotId" AND line."stockLocationId" = movement."stockLocationId"
        AND movement."branchId" = NEW."branchId" AND movement."inventoryLotId" = NEW."inventoryLotId"
        AND movement.kind = 'ADJUSTMENT' AND movement.disposition = 'AVAILABLE'
        AND movement."idempotencyKey" = 'supplier-return:' || line.id || ':out'
        AND movement."actorId" = NEW."recordedByUserId" AND movement."quantityUnits" = -line."quantityUnits"
        AND NEW."quantityCanonicalUnits" = line."quantityUnits" AND NEW."balanceDelta" = movement."quantityUnits"
        AND purchase."quantityCanonicalUnits" >= (SELECT sum(r."quantityCanonicalUnits") FROM pharmacy_controlled_register_entries r
          WHERE r."organizationId" = NEW."organizationId" AND r."sourcePurchaseEntryId" = purchase.id)
    ) THEN
      RAISE EXCEPTION 'controlled supplier return must match the original purchase and outgoing dispatch movement' USING ERRCODE='23514';
    END IF;
    SELECT "runningBalance" INTO previous_balance FROM pharmacy_controlled_register_entries
      WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId" AND "inventoryLotId"=NEW."inventoryLotId"
        AND "medicineId"=NEW."medicineId" AND serial < NEW.serial ORDER BY serial DESC LIMIT 1;
    IF previous_balance + NEW."balanceDelta" IS DISTINCT FROM NEW."runningBalance" THEN
      RAISE EXCEPTION 'controlled supplier return balance must follow the previous entry' USING ERRCODE='23514';
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
      AND "disposition" NOT IN ('QUARANTINE', 'RETURN_TO_SUPPLIER');
  IF NEW."runningBalance"<>actual THEN
    IF NEW."entryKind" = 'RETURN_TO_SUPPLIER' THEN
      RAISE EXCEPTION 'controlled supplier return must reconcile with stock on hand' USING ERRCODE='23514';
    END IF;
    INSERT INTO "pharmacy_register_incidents" ("id","organizationId","branchId","registerEntryId","expectedBalance","actualBalance")
    VALUES ('ri_'||md5(random()::text||clock_timestamp()::text),NEW."organizationId",NEW."branchId",NEW."id",NEW."runningBalance",actual);
  END IF;
  RETURN NEW;
END $$;

COMMIT;
