-- OFF-03 quotas reserve physical stock for a disconnected counter. Keep the
-- outstanding reservation on the same row as the stock projection: concurrent
-- quota grants and movements then contend on one tuple, and PostgreSQL
-- re-evaluates an UPDATE against the latest tuple after a lock wait. This avoids
-- relying on a quota-table aggregate taken from the movement statement's older
-- READ COMMITTED snapshot.
ALTER TABLE "pharmacy_stock_balances"
  ADD COLUMN "offlineReservedUnits" INTEGER NOT NULL DEFAULT 0;

-- Preserve reservations that were open before this projection column existed.
-- Balance triggers normally prohibit direct writes, so disable them only for
-- this one-time derivation while the migration holds its table locks.
ALTER TABLE "pharmacy_stock_balances" DISABLE TRIGGER USER;
UPDATE "pharmacy_stock_balances" balance
SET "offlineReservedUnits" = quota.outstanding
FROM (
  SELECT "organizationId", "branchId", "inventoryLotId", "stockLocationId",
         SUM("quotaUnits" - "consumedUnits")::integer AS outstanding
  FROM "pharmacy_device_lot_quotas"
  WHERE "releasedAt" IS NULL
  GROUP BY "organizationId", "branchId", "inventoryLotId", "stockLocationId"
) quota
WHERE balance."organizationId" = quota."organizationId"
  AND balance."branchId" = quota."branchId"
  AND balance."inventoryLotId" = quota."inventoryLotId"
  AND balance."stockLocationId" = quota."stockLocationId"
  AND balance."disposition" = 'AVAILABLE';
ALTER TABLE "pharmacy_stock_balances" ENABLE TRIGGER USER;

ALTER TABLE "pharmacy_stock_balances"
  ADD CONSTRAINT "pharmacy_stock_balances_offline_reserved_check"
    CHECK ("offlineReservedUnits" >= 0 AND "offlineReservedUnits" <= "onHandUnits");

-- Replace the aggregate-based quota guard. Each quota mutation atomically
-- applies its change in outstanding units to the matching AVAILABLE balance.
-- The conditional UPDATE is both the capacity check and the serialization
-- point shared with pharmacy_apply_stock_movement.
CREATE OR REPLACE FUNCTION guard_pharmacy_device_lot_quota() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_outstanding integer := 0;
  new_outstanding integer := 0;
  reservation_delta integer;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."releasedAt" IS NULL THEN
    old_outstanding := OLD."quotaUnits" - OLD."consumedUnits";
  END IF;
  IF NEW."releasedAt" IS NULL THEN
    new_outstanding := NEW."quotaUnits" - NEW."consumedUnits";
  END IF;
  reservation_delta := new_outstanding - old_outstanding;

  IF reservation_delta = 0 THEN
    RETURN NEW;
  END IF;

  UPDATE "pharmacy_stock_balances"
  SET "offlineReservedUnits" = "offlineReservedUnits" + reservation_delta
  WHERE "organizationId" = NEW."organizationId"
    AND "branchId" = NEW."branchId"
    AND "inventoryLotId" = NEW."inventoryLotId"
    AND "stockLocationId" = NEW."stockLocationId"
    AND "disposition" = 'AVAILABLE'
    AND "offlineReservedUnits" + reservation_delta >= 0
    AND "offlineReservedUnits" + reservation_delta <= "onHandUnits";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUOTA_EXCEEDS_ON_HAND' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

-- Movement projection updates preserve offlineReservedUnits automatically.
-- Check the proposed tuple directly, rather than consulting another table, so
-- a movement that waited behind a grant necessarily observes its reservation.
CREATE FUNCTION guard_pharmacy_stock_balance_offline_quota() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."disposition" = 'AVAILABLE'
     AND NEW."onHandUnits" < NEW."offlineReservedUnits" THEN
    RAISE EXCEPTION 'OFFLINE_QUOTA_RESERVES_STOCK' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pharmacy_stock_balances_offline_quota_guard"
  BEFORE INSERT OR UPDATE ON "pharmacy_stock_balances"
  FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_stock_balance_offline_quota();
