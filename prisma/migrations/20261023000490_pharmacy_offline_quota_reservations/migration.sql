-- OFF-03: an unreplayed device quota is a reservation against its exact
-- organization/branch/lot/location bucket.  Every AVAILABLE decrement must
-- leave those reservations intact.  Quota replay consumes its reservation
-- before posting the corresponding movement, so the reserved units remain
-- usable by the owning device without being available to online movements.
CREATE FUNCTION guard_pharmacy_stock_movement_offline_quotas() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  on_hand integer;
  outstanding integer;
BEGIN
  IF NEW."disposition" <> 'AVAILABLE' OR NEW."quantityUnits" >= 0 THEN
    RETURN NEW;
  END IF;

  -- This is the same first lock used by the quota capacity guard.  Sharing the
  -- lock order makes grants, consumption and ordinary movements serialize.
  SELECT "onHandUnits" INTO on_hand
  FROM "pharmacy_stock_balances"
  WHERE "organizationId" = NEW."organizationId"
    AND "branchId" = NEW."branchId"
    AND "inventoryLotId" = NEW."inventoryLotId"
    AND "stockLocationId" = NEW."stockLocationId"
    AND "disposition" = 'AVAILABLE'
  FOR UPDATE;

  SELECT COALESCE(SUM(quota."quotaUnits" - quota."consumedUnits"), 0) INTO outstanding
  FROM "pharmacy_device_lot_quotas" quota
  WHERE quota."organizationId" = NEW."organizationId"
    AND quota."branchId" = NEW."branchId"
    AND quota."inventoryLotId" = NEW."inventoryLotId"
    AND quota."stockLocationId" = NEW."stockLocationId"
    AND quota."releasedAt" IS NULL;

  IF on_hand IS NOT NULL AND on_hand + NEW."quantityUnits" < outstanding THEN
    RAISE EXCEPTION 'OFFLINE_QUOTA_RESERVED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pharmacy_stock_movements_preserve_offline_quotas
  BEFORE INSERT ON "pharmacy_stock_movements"
  FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_stock_movement_offline_quotas();
