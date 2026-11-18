-- DEV-853 — legacy opening stock with no batch number and/or no expiry.
--
-- Owner decision: opening stock imports with whatever the old system has. A
-- lot with no batch number and/or no expiry is stored as NOT AVAILABLE (NULL —
-- never an invented batch or date) and IS sellable. An unknown expiry is never
-- treated as expired; FEFO picks lots with a known expiry first. Staff record
-- the real batch and expiry later, which fills the NULL once.
--
-- The block on stock whose KNOWN expiry has passed is unchanged.
BEGIN;

-- The manufacturing batch: number and expiry may be unrecorded. The existing
-- number CHECK (length(btrim(...)) > 0) still refuses a blank string; a NULL
-- passes it, and the (organization, medicine, number) UNIQUE key admits any
-- number of unrecorded batches.
ALTER TABLE "pharmacy_manufacturing_batches" ALTER COLUMN "batchNumber" DROP NOT NULL;
ALTER TABLE "pharmacy_manufacturing_batches" ALTER COLUMN "expiresAt" DROP NOT NULL;

-- The lot's received expiry: both recorded or both not.
ALTER TABLE "pharmacy_inventory_lots" ALTER COLUMN "receivedExpiresAt" DROP NOT NULL;
ALTER TABLE "pharmacy_inventory_lots" ALTER COLUMN "receivedExpiryPrecision" DROP NOT NULL;
ALTER TABLE "pharmacy_inventory_lots"
  DROP CONSTRAINT IF EXISTS "pharmacy_inventory_lots_received_expiry_pair_check";
ALTER TABLE "pharmacy_inventory_lots"
  ADD CONSTRAINT "pharmacy_inventory_lots_received_expiry_pair_check"
  CHECK (("receivedExpiresAt" IS NULL) = ("receivedExpiryPrecision" IS NULL));

-- An opening line may post without a batch number or an expiry. It still needs
-- a manufacturing batch row (which may itself carry no number), a source ref,
-- MRP, cost, location, pack and count. A posted line's expiry date and
-- precision are both present or both absent.
ALTER TABLE "pharmacy_opening_stock_lines"
  DROP CONSTRAINT IF EXISTS "pharmacy_opening_stock_lines_complete_before_post_check";
ALTER TABLE "pharmacy_opening_stock_lines"
  ADD CONSTRAINT "pharmacy_opening_stock_lines_complete_before_post_check" CHECK (
    "status" <> 'POSTED' OR (
      "sourceRef" IS NOT NULL
      AND "manufacturingBatchId" IS NOT NULL
      AND ("expiryDate" IS NULL) = ("expiryPrecision" IS NULL)
      AND "printedMrpMinor" IS NOT NULL
      AND "unitCostMinor" IS NOT NULL
      AND "stockLocationId" IS NOT NULL
      AND "packLevelId" IS NOT NULL
      AND "unitsPerPack" IS NOT NULL
      AND "countedUnits" IS NOT NULL
      AND "postedLotId" IS NOT NULL
      AND "postedMovementId" IS NOT NULL));

-- A controlled-register entry for a lot with no recorded batch number stores
-- NULL, never a label. The reconcile trigger compares the entry with the lot's
-- batch using IS DISTINCT FROM, so NULL matches NULL and any other mismatch is
-- still refused. Screens print "Batch not recorded".
ALTER TABLE "pharmacy_controlled_register_entries" ALTER COLUMN "batchNumber" DROP NOT NULL;

-- A restock reservation may hold stock whose expiry was never recorded: it is
-- sellable stock. Stock whose known expiry has passed stays refused.
CREATE OR REPLACE FUNCTION pharmacy_validate_restock_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE available_units INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."organizationId", NEW."branchId", NEW."interestId", NEW."inventoryLotId", NEW."stockLocationId", NEW."reservedUnits", NEW."createdAt") IS DISTINCT FROM (OLD."organizationId", OLD."branchId", OLD."interestId", OLD."inventoryLotId", OLD."stockLocationId", OLD."reservedUnits", OLD."createdAt")
      OR OLD."status" <> 'RESERVED' OR NEW."status" NOT IN ('CONSUMED', 'RELEASED') THEN
      RAISE EXCEPTION 'restock reservation payload or settled state is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  SELECT balance."onHandUnits" - COALESCE((SELECT SUM(c."reservedUnits") FROM "pharmacy_supplier_claims" c WHERE c."organizationId" = NEW."organizationId" AND c."branchId" = NEW."branchId" AND c."inventoryLotId" = NEW."inventoryLotId" AND c."status" = 'RESERVED'), 0) - COALESCE((SELECT SUM(r."reservedUnits") FROM "pharmacy_restock_reservations" r WHERE r."organizationId" = NEW."organizationId" AND r."branchId" = NEW."branchId" AND r."inventoryLotId" = NEW."inventoryLotId" AND r."stockLocationId" = NEW."stockLocationId" AND r."status" = 'RESERVED'), 0)
  INTO available_units
  FROM "pharmacy_stock_balances" balance
  JOIN "pharmacy_inventory_lots" lot ON lot."organizationId" = balance."organizationId" AND lot."branchId" = balance."branchId" AND lot."id" = balance."inventoryLotId"
  JOIN "pharmacy_manufacturing_batches" batch ON batch."organizationId" = lot."organizationId" AND batch."id" = lot."manufacturingBatchId"
  JOIN "pharmacy_restock_interests" interest ON interest."organizationId" = NEW."organizationId" AND interest."branchId" = NEW."branchId" AND interest."id" = NEW."interestId"
  JOIN "pharmacy_unfulfilled_demand_events" demand ON demand."organizationId" = interest."organizationId" AND demand."id" = interest."demandEventId"
  WHERE balance."organizationId" = NEW."organizationId" AND balance."branchId" = NEW."branchId" AND balance."inventoryLotId" = NEW."inventoryLotId" AND balance."stockLocationId" = NEW."stockLocationId" AND balance."disposition" = 'AVAILABLE' AND lot."receivedAt" IS NOT NULL AND batch."state" = 'ACTIVE' AND (batch."expiresAt" IS NULL OR batch."expiresAt" > CURRENT_TIMESTAMP) AND demand."requestedMedicineId" = batch."medicineId"
  FOR UPDATE OF balance;
  IF available_units IS NULL OR available_units < NEW."reservedUnits" THEN RAISE EXCEPTION 'restock reservation exceeds safe available stock' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;

COMMIT;
