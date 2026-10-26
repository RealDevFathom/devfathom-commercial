-- OFF-03 quotas reserve physical stock for a disconnected counter. Enforce the
-- reservation on the balance projection itself so every row of a batched
-- movement insert observes the balance left by the preceding row. The UPDATE
-- has already locked this balance row before its row-level triggers run; quota
-- grants take the same lock in guard_pharmacy_device_lot_quota, serializing the
-- two operations in either order.
CREATE FUNCTION guard_pharmacy_stock_balance_offline_quota() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  outstanding integer;
BEGIN
  IF NEW."disposition" <> 'AVAILABLE'
     OR (TG_OP = 'UPDATE' AND NEW."onHandUnits" >= OLD."onHandUnits") THEN
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

  IF NEW."onHandUnits" < outstanding THEN
    RAISE EXCEPTION 'OFFLINE_QUOTA_RESERVES_STOCK' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pharmacy_stock_balances_offline_quota_guard"
  BEFORE INSERT OR UPDATE ON "pharmacy_stock_balances"
  FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_stock_balance_offline_quota();
