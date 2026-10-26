-- OFF-03 quotas reserve physical stock for a disconnected counter. Serialize
-- every AVAILABLE decrement with quota grants/consumption by taking the same
-- balance-row lock used by guard_pharmacy_device_lot_quota, then refuse any
-- movement that would leave fewer units than all open quotas still own.
CREATE FUNCTION guard_pharmacy_stock_movement_offline_quota() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  on_hand integer;
  outstanding integer;
BEGIN
  IF NEW."disposition" <> 'AVAILABLE' OR NEW."quantityUnits" >= 0 THEN
    RETURN NEW;
  END IF;

  SELECT balance."onHandUnits" INTO on_hand
  FROM "pharmacy_stock_balances" balance
  WHERE balance."organizationId" = NEW."organizationId"
    AND balance."branchId" = NEW."branchId"
    AND balance."inventoryLotId" = NEW."inventoryLotId"
    AND balance."stockLocationId" = NEW."stockLocationId"
    AND balance."disposition" = 'AVAILABLE'
  FOR UPDATE;

  -- A missing balance is rejected by the existing non-negative projection
  -- invariant. Avoid replacing that established error with a quota error.
  IF on_hand IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(quota."quotaUnits" - quota."consumedUnits"), 0)
  INTO outstanding
  FROM "pharmacy_device_lot_quotas" quota
  WHERE quota."organizationId" = NEW."organizationId"
    AND quota."branchId" = NEW."branchId"
    AND quota."inventoryLotId" = NEW."inventoryLotId"
    AND quota."stockLocationId" = NEW."stockLocationId"
    AND quota."releasedAt" IS NULL;

  IF on_hand + NEW."quantityUnits" < outstanding THEN
    RAISE EXCEPTION 'OFFLINE_QUOTA_RESERVES_STOCK' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pharmacy_stock_movements_offline_quota_guard"
  BEFORE INSERT ON "pharmacy_stock_movements"
  FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_stock_movement_offline_quota();
