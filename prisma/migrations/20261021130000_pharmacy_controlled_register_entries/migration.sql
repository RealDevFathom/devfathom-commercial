-- Extend the existing controlled register. Rows stay append-only.
-- Purchases and corrections are new kinds of row, not a second register.
CREATE TYPE "PharmacyControlledRegisterKind" AS ENUM ('SALE', 'PURCHASE', 'CORRECTION');

ALTER TABLE "pharmacy_patients" ADD COLUMN "address" TEXT;

ALTER TABLE "pharmacy_goods_receipts" ADD COLUMN "qualifiedPersonUserId" TEXT;

ALTER TABLE "pharmacy_controlled_register_entries"
  ADD COLUMN "entryKind" "PharmacyControlledRegisterKind" NOT NULL DEFAULT 'SALE',
  ADD COLUMN "prescriberName" TEXT,
  ADD COLUMN "prescriberRegNo" TEXT,
  ADD COLUMN "patientAddress" TEXT,
  ADD COLUMN "medicineId" TEXT,
  ADD COLUMN "manufacturer" TEXT,
  ADD COLUMN "balanceDelta" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "signatureRef" TEXT,
  ADD COLUMN "rxSerialWritten" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "emergency" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "counterpartyName" TEXT,
  ADD COLUMN "correctionReason" TEXT,
  ADD COLUMN "correctsEntryId" TEXT,
  ADD COLUMN "refEntryId" TEXT;

ALTER TABLE "pharmacy_controlled_register_entries"
  ALTER COLUMN "prescriptionId" DROP NOT NULL,
  ALTER COLUMN "prescriptionLineId" DROP NOT NULL,
  ALTER COLUMN "patientId" DROP NOT NULL,
  ALTER COLUMN "prescriberId" DROP NOT NULL,
  ALTER COLUMN "stockMovementId" DROP NOT NULL;

ALTER TABLE "pharmacy_controlled_register_entries"
  ADD CONSTRAINT "pharmacy_controlled_register_medicine_fkey"
    FOREIGN KEY ("organizationId", "medicineId")
    REFERENCES "pharmacy_medicines" ("organizationId", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "pharmacy_controlled_register_corrects_fkey"
    FOREIGN KEY ("organizationId", "correctsEntryId")
    REFERENCES "pharmacy_controlled_register_entries" ("organizationId", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "pharmacy_controlled_register_ref_fkey"
    FOREIGN KEY ("organizationId", "refEntryId")
    REFERENCES "pharmacy_controlled_register_entries" ("organizationId", "id") ON DELETE RESTRICT;

ALTER TABLE "pharmacy_controlled_register_entries"
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
  );

CREATE INDEX "pharmacy_controlled_register_kind_idx"
  ON "pharmacy_controlled_register_entries" ("organizationId", "branchId", "entryKind", "serial");

-- Sales and purchases still have to match the stock ledger.
-- A correction names an earlier row and does not require a movement.
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
      AND "inventoryLotId"=NEW."inventoryLotId";
  IF NEW."runningBalance"<>actual THEN
    INSERT INTO "pharmacy_register_incidents" ("id","organizationId","branchId","registerEntryId","expectedBalance","actualBalance")
    VALUES ('ri_'||md5(random()::text||clock_timestamp()::text),NEW."organizationId",NEW."branchId",NEW."id",NEW."runningBalance",actual);
  END IF;
  RETURN NEW;
END $$;
