-- DEV-608 stranded same-branch transfers: DRY RUN (read-only, changes nothing).
--
-- Background: before DEV-608, a same-branch location move
-- (pharmacyInventory.transfer -> transferStock) posted its receiving leg as
-- IN_TRANSIT with no transfer record, so nothing could receive or cancel it.
-- Those units are on hand but unsaleable. The code fix lands new moves
-- AVAILABLE; it does not touch rows already posted. See the runbook:
-- docs/operations/dev-608-stranded-transfer-repair.md
--
-- NOT A PRISMA MIGRATION. `prisma migrate deploy` reads prisma/migrations only,
-- and nothing applies this file automatically. An operator runs it by hand, per
-- environment, after approval.
--
-- Lists every stranded pair, whether repair.sql would reverse it, and why not
-- when it is held back, then the counts. Run it first and keep its output:
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/operations/dev-608-stranded-transfer-repair/dry-run.sql
BEGIN READ ONLY;
SELECT set_config('app.is_platform_admin', 'true', true);

-- candidates:begin
WITH stranded AS (
  -- The old same-branch transferStock posted '<prefix>:out' (TRANSFER_OUT,
  -- AVAILABLE, at the origin) and '<prefix>:in' (TRANSFER_IN, IN_TRANSIT, at the
  -- destination). No other writer posts a TRANSFER_IN to IN_TRANSIT under an
  -- ':in' key: inter-branch dispatch uses ':transit', receipt uses ':received'.
  SELECT
    leg_in."organizationId",
    leg_in."branchId",
    leg_in."inventoryLotId",
    leg_out."stockLocationId" AS "originLocationId",
    leg_in."stockLocationId" AS "destinationLocationId",
    leg_in."quantityUnits" AS "units",
    leg_in."sealedPackDelta" AS "sealedPacks",
    leg_in."looseUnitDelta" AS "looseUnits",
    leg_out."id" AS "outMovementId",
    leg_out."idempotencyKey" AS "outKey",
    leg_in."id" AS "inMovementId",
    leg_in."idempotencyKey" AS "inKey",
    leg_in."occurredAt"
  FROM "pharmacy_stock_movements" leg_in
  JOIN "pharmacy_stock_movements" leg_out
    ON leg_out."organizationId" = leg_in."organizationId"
   AND leg_out."branchId" = leg_in."branchId"
   AND leg_out."inventoryLotId" = leg_in."inventoryLotId"
   AND leg_out."idempotencyKey" = left(leg_in."idempotencyKey", -3) || ':out'
   AND leg_out."kind" = 'TRANSFER_OUT'
   AND leg_out."disposition" = 'AVAILABLE'
   AND leg_out."quantityUnits" = -leg_in."quantityUnits"
   AND leg_out."sealedPackDelta" = -leg_in."sealedPackDelta"
   AND leg_out."looseUnitDelta" = -leg_in."looseUnitDelta"
   AND leg_out."reversesMovementId" IS NULL
  WHERE leg_in."kind" = 'TRANSFER_IN'
    AND leg_in."disposition" = 'IN_TRANSIT'
    AND leg_in."idempotencyKey" LIKE '%:in'
    AND leg_in."reversesMovementId" IS NULL
    -- Already repaired (or otherwise reversed): never touched again.
    AND NOT EXISTS (
      SELECT 1 FROM "pharmacy_stock_movements" reversal
      WHERE reversal."organizationId" = leg_in."organizationId"
        AND reversal."reversesMovementId" IN (leg_in."id", leg_out."id")
    )
),
bucketed AS (
  -- Every stranded pair landing in the same IN_TRANSIT bucket draws on the same
  -- balance, so the balance must cover all of them together.
  SELECT
    stranded.*,
    SUM(stranded."units") OVER bucket AS "bucketUnits",
    SUM(stranded."sealedPacks") OVER bucket AS "bucketSealedPacks",
    SUM(stranded."looseUnits") OVER bucket AS "bucketLooseUnits"
  FROM stranded
  WINDOW bucket AS (
    PARTITION BY stranded."organizationId", stranded."inventoryLotId", stranded."destinationLocationId"
  )
),
candidates AS (
  SELECT
    bucketed.*,
    COALESCE(balance."onHandUnits", 0) AS "inTransitUnitsHeld",
    medicine."coldChain" AS "medicineColdChain",
    origin."coldChain" AS "originColdChain",
    CASE
      -- Some of the stranded units were since counted, adjusted or written off:
      -- reversing the full pair would drive the bucket negative. Manual review.
      WHEN balance."onHandUnits" IS NULL
        OR balance."onHandUnits" < bucketed."bucketUnits"
        OR balance."sealedPacks" < bucketed."bucketSealedPacks"
        OR balance."looseUnits" < bucketed."bucketLooseUnits"
        THEN 'IN_TRANSIT_BALANCE_SHORT'
      -- INV-05: cold-chain stock only returns AVAILABLE to a validated zone.
      WHEN medicine."coldChain" AND NOT origin."coldChain"
        THEN 'ORIGIN_NOT_COLD_CHAIN'
      ELSE NULL
    END AS "heldBack"
  FROM bucketed
  JOIN "pharmacy_inventory_lots" lot
    ON lot."organizationId" = bucketed."organizationId" AND lot."id" = bucketed."inventoryLotId"
  JOIN "pharmacy_manufacturing_batches" batch
    ON batch."organizationId" = lot."organizationId" AND batch."id" = lot."manufacturingBatchId"
  JOIN "pharmacy_medicines" medicine
    ON medicine."organizationId" = batch."organizationId" AND medicine."id" = batch."medicineId"
  JOIN "pharmacy_stock_locations" origin
    ON origin."organizationId" = bucketed."organizationId" AND origin."id" = bucketed."originLocationId"
  LEFT JOIN "pharmacy_stock_balances" balance
    ON balance."organizationId" = bucketed."organizationId"
   AND balance."inventoryLotId" = bucketed."inventoryLotId"
   AND balance."stockLocationId" = bucketed."destinationLocationId"
   AND balance."disposition" = 'IN_TRANSIT'
)
-- candidates:end
SELECT
  "organizationId", "branchId", "inventoryLotId",
  "originLocationId", "destinationLocationId",
  "units", "sealedPacks", "looseUnits",
  "outMovementId", "inMovementId", "inKey", "occurredAt",
  "inTransitUnitsHeld", "bucketUnits",
  "heldBack" IS NULL AS "willRepair",
  "heldBack"
FROM candidates
ORDER BY "organizationId", "branchId", "occurredAt", "inMovementId";

-- Row counts. repair.sql must report exactly 2 x "pairsToRepair" movements.
-- candidates:begin
WITH stranded AS (
  -- The old same-branch transferStock posted '<prefix>:out' (TRANSFER_OUT,
  -- AVAILABLE, at the origin) and '<prefix>:in' (TRANSFER_IN, IN_TRANSIT, at the
  -- destination). No other writer posts a TRANSFER_IN to IN_TRANSIT under an
  -- ':in' key: inter-branch dispatch uses ':transit', receipt uses ':received'.
  SELECT
    leg_in."organizationId",
    leg_in."branchId",
    leg_in."inventoryLotId",
    leg_out."stockLocationId" AS "originLocationId",
    leg_in."stockLocationId" AS "destinationLocationId",
    leg_in."quantityUnits" AS "units",
    leg_in."sealedPackDelta" AS "sealedPacks",
    leg_in."looseUnitDelta" AS "looseUnits",
    leg_out."id" AS "outMovementId",
    leg_out."idempotencyKey" AS "outKey",
    leg_in."id" AS "inMovementId",
    leg_in."idempotencyKey" AS "inKey",
    leg_in."occurredAt"
  FROM "pharmacy_stock_movements" leg_in
  JOIN "pharmacy_stock_movements" leg_out
    ON leg_out."organizationId" = leg_in."organizationId"
   AND leg_out."branchId" = leg_in."branchId"
   AND leg_out."inventoryLotId" = leg_in."inventoryLotId"
   AND leg_out."idempotencyKey" = left(leg_in."idempotencyKey", -3) || ':out'
   AND leg_out."kind" = 'TRANSFER_OUT'
   AND leg_out."disposition" = 'AVAILABLE'
   AND leg_out."quantityUnits" = -leg_in."quantityUnits"
   AND leg_out."sealedPackDelta" = -leg_in."sealedPackDelta"
   AND leg_out."looseUnitDelta" = -leg_in."looseUnitDelta"
   AND leg_out."reversesMovementId" IS NULL
  WHERE leg_in."kind" = 'TRANSFER_IN'
    AND leg_in."disposition" = 'IN_TRANSIT'
    AND leg_in."idempotencyKey" LIKE '%:in'
    AND leg_in."reversesMovementId" IS NULL
    -- Already repaired (or otherwise reversed): never touched again.
    AND NOT EXISTS (
      SELECT 1 FROM "pharmacy_stock_movements" reversal
      WHERE reversal."organizationId" = leg_in."organizationId"
        AND reversal."reversesMovementId" IN (leg_in."id", leg_out."id")
    )
),
bucketed AS (
  -- Every stranded pair landing in the same IN_TRANSIT bucket draws on the same
  -- balance, so the balance must cover all of them together.
  SELECT
    stranded.*,
    SUM(stranded."units") OVER bucket AS "bucketUnits",
    SUM(stranded."sealedPacks") OVER bucket AS "bucketSealedPacks",
    SUM(stranded."looseUnits") OVER bucket AS "bucketLooseUnits"
  FROM stranded
  WINDOW bucket AS (
    PARTITION BY stranded."organizationId", stranded."inventoryLotId", stranded."destinationLocationId"
  )
),
candidates AS (
  SELECT
    bucketed.*,
    COALESCE(balance."onHandUnits", 0) AS "inTransitUnitsHeld",
    medicine."coldChain" AS "medicineColdChain",
    origin."coldChain" AS "originColdChain",
    CASE
      -- Some of the stranded units were since counted, adjusted or written off:
      -- reversing the full pair would drive the bucket negative. Manual review.
      WHEN balance."onHandUnits" IS NULL
        OR balance."onHandUnits" < bucketed."bucketUnits"
        OR balance."sealedPacks" < bucketed."bucketSealedPacks"
        OR balance."looseUnits" < bucketed."bucketLooseUnits"
        THEN 'IN_TRANSIT_BALANCE_SHORT'
      -- INV-05: cold-chain stock only returns AVAILABLE to a validated zone.
      WHEN medicine."coldChain" AND NOT origin."coldChain"
        THEN 'ORIGIN_NOT_COLD_CHAIN'
      ELSE NULL
    END AS "heldBack"
  FROM bucketed
  JOIN "pharmacy_inventory_lots" lot
    ON lot."organizationId" = bucketed."organizationId" AND lot."id" = bucketed."inventoryLotId"
  JOIN "pharmacy_manufacturing_batches" batch
    ON batch."organizationId" = lot."organizationId" AND batch."id" = lot."manufacturingBatchId"
  JOIN "pharmacy_medicines" medicine
    ON medicine."organizationId" = batch."organizationId" AND medicine."id" = batch."medicineId"
  JOIN "pharmacy_stock_locations" origin
    ON origin."organizationId" = bucketed."organizationId" AND origin."id" = bucketed."originLocationId"
  LEFT JOIN "pharmacy_stock_balances" balance
    ON balance."organizationId" = bucketed."organizationId"
   AND balance."inventoryLotId" = bucketed."inventoryLotId"
   AND balance."stockLocationId" = bucketed."destinationLocationId"
   AND balance."disposition" = 'IN_TRANSIT'
)
-- candidates:end
SELECT
  COUNT(*) AS "strandedPairs",
  COUNT(*) FILTER (WHERE "heldBack" IS NULL) AS "pairsToRepair",
  COALESCE(SUM("units") FILTER (WHERE "heldBack" IS NULL), 0) AS "unitsToReturn",
  COUNT(*) FILTER (WHERE "heldBack" = 'IN_TRANSIT_BALANCE_SHORT') AS "heldBackBalanceShort",
  COUNT(*) FILTER (WHERE "heldBack" = 'ORIGIN_NOT_COLD_CHAIN') AS "heldBackColdChain",
  COUNT(DISTINCT "organizationId") AS "organizations"
FROM candidates;

ROLLBACK;
