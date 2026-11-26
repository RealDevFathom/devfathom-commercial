BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE pharmacy_medicines ADD COLUMN IF NOT EXISTS "wholePackOnly" boolean NOT NULL DEFAULT false;
-- Classify existing catalogue entries under their own tenant policies.
SELECT set_config('app.is_platform_admin', 'true', true);
DO $$
DECLARE tenant_id text;
BEGIN
  FOR tenant_id IN SELECT id FROM organizations ORDER BY id LOOP
    PERFORM set_config('app.current_organization_id', tenant_id, true);
    UPDATE pharmacy_medicines m SET "wholePackOnly" = true
    WHERE m."organizationId" = tenant_id AND NOT m."wholePackOnly"
      AND NOT EXISTS (SELECT FROM pharmacy_presentations p
        WHERE p."organizationId"=tenant_id AND p."medicineId"=m.id
          AND p."dosageForm" ~* 'tablet|capsule');
  END LOOP;
  PERFORM set_config('app.current_organization_id', '', true);
END $$;

ALTER TABLE pharmacy_stock_movements ADD COLUMN IF NOT EXISTS "counterSaleId" text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid = 'pharmacy_stock_movements'::regclass
    AND conname = 'pharmacy_stock_movements_counter_sale_fkey') THEN
    ALTER TABLE pharmacy_stock_movements ADD CONSTRAINT pharmacy_stock_movements_counter_sale_fkey
      FOREIGN KEY ("organizationId", "branchId", "counterSaleId")
      REFERENCES pharmacy_sales ("organizationId", "branchId", id) ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
ALTER TABLE pharmacy_stock_movements ADD COLUMN IF NOT EXISTS "counterPackDraws" jsonb;

-- New counter openings have an empty map. Older rows lack provenance and are never resealed.
-- An outgoing loose movement records how many units it drew from each labelled pack.
CREATE OR REPLACE FUNCTION pharmacy_counter_open_packs(tenant text, branch text, lot text, location text)
RETURNS TABLE(id text, opening_key text, capacity integer, remaining integer)
LANGUAGE sql STABLE AS $$
  WITH active AS (
    SELECT m.* FROM pharmacy_stock_movements m
    WHERE m."organizationId" = tenant AND m."branchId" = branch AND m."inventoryLotId" = lot
      AND m."stockLocationId" = location AND m.disposition = 'AVAILABLE'
      AND m."counterPackDraws" IS NOT NULL
      AND NOT EXISTS (SELECT FROM pharmacy_stock_movements r
        WHERE r."organizationId" = tenant AND r."reversesMovementId" = m.id)
  ), drawn AS (
    SELECT source.key AS opening, sum(source.value::integer) AS units
    FROM active debit CROSS JOIN LATERAL jsonb_each_text(debit."counterPackDraws") source
    GROUP BY source.key
  )
  SELECT p.id, p."idempotencyKey", p."looseUnitDelta",
         (p."looseUnitDelta" - coalesce(d.units, 0))::integer
  FROM active p LEFT JOIN drawn d ON d.opening = p.id
  WHERE p.kind = 'BREAK_PACK' AND p."counterSaleId" IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION pharmacy_attribute_counter_pack_draws() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE physical_open integer; needed integer; amount integer; pack record;
BEGIN
  NEW."counterPackDraws" := NULL;
  IF NEW.disposition <> 'AVAILABLE' THEN RETURN NEW; END IF;
  IF NEW.kind = 'BREAK_PACK' AND NEW."counterSaleId" IS NOT NULL THEN
    NEW."counterPackDraws" := '{}'::jsonb;
    RETURN NEW;
  END IF;
  IF NEW."looseUnitDelta" >= 0 THEN RETURN NEW; END IF;

  SELECT "looseUnits" INTO physical_open FROM pharmacy_stock_balances
    WHERE "organizationId" = NEW."organizationId" AND "branchId" = NEW."branchId"
      AND "inventoryLotId" = NEW."inventoryLotId" AND "stockLocationId" = NEW."stockLocationId"
      AND disposition = NEW.disposition FOR UPDATE;

  IF NEW.kind = 'ADJUSTMENT' AND NEW."quantityUnits" = 0 THEN
    -- The general reversal trigger also checks exact negation, tenant and bucket.
    IF NOT EXISTS (
      SELECT FROM pharmacy_counter_open_packs(NEW."organizationId", NEW."branchId",
               NEW."inventoryLotId", NEW."stockLocationId") p
      JOIN pharmacy_stock_movements opening ON opening.id = p.id AND opening."organizationId" = NEW."organizationId"
      JOIN pharmacy_stock_movements sale ON sale."organizationId" = opening."organizationId"
        AND sale."counterSaleId" = opening."counterSaleId" AND sale.kind = 'SALE'
        AND sale."idempotencyKey" = regexp_replace(p.opening_key, ':open:[0-9]+$', '')
      JOIN pharmacy_stock_movements undo ON undo."organizationId" = sale."organizationId" AND undo."reversesMovementId" = sale.id
      WHERE p.id = NEW."reversesMovementId" AND opening."counterSaleId" = NEW."counterSaleId"
        AND p.remaining = p.capacity
    ) THEN RAISE EXCEPTION 'counter pack still in use or opening not reversible' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;

  -- Use pre-existing unlabelled loose stock, then earlier opened stock, then
  -- packs opened for this debit. All readers/writers share the physical balance lock.
  FOR pack IN
    SELECT p.*, sum(p.remaining) OVER () AS tracked
    FROM pharmacy_counter_open_packs(NEW."organizationId", NEW."branchId",
            NEW."inventoryLotId", NEW."stockLocationId") p WHERE p.remaining > 0
    ORDER BY starts_with(p.opening_key, NEW."idempotencyKey" || ':open:'), p.remaining, p.id
  LOOP
    IF needed IS NULL THEN
      needed := -NEW."looseUnitDelta" - greatest(0, physical_open - pack.tracked);
    END IF;
    EXIT WHEN needed <= 0;
    amount := least(needed, pack.remaining);
    NEW."counterPackDraws" := coalesce(NEW."counterPackDraws", '{}'::jsonb) || jsonb_build_object(pack.id, amount);
    needed := needed - amount;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pharmacy_attribute_counter_packs ON pharmacy_stock_movements;
CREATE TRIGGER pharmacy_attribute_counter_packs BEFORE INSERT ON pharmacy_stock_movements
FOR EACH ROW EXECUTE FUNCTION pharmacy_attribute_counter_pack_draws();

ALTER TABLE pharmacy_stock_movements DROP CONSTRAINT pharmacy_stock_movements_direction_check;
ALTER TABLE pharmacy_stock_movements ADD CONSTRAINT pharmacy_stock_movements_direction_check CHECK (
  (kind IN ('RECEIPT','RETURN','TRANSFER_IN','OPENING') AND "quantityUnits" > 0)
  OR (kind IN ('SALE','TRANSFER_OUT','WRITE_OFF') AND "quantityUnits" < 0)
  OR (kind = 'ADJUSTMENT' AND "quantityUnits" <> 0)
  OR (kind = 'BREAK_PACK' AND "quantityUnits" = 0 AND "sealedPackDelta" < 0 AND "looseUnitDelta" > 0)
  OR (kind = 'ADJUSTMENT' AND "quantityUnits" = 0 AND disposition = 'AVAILABLE'
      AND "sealedPackDelta" = 1 AND "looseUnitDelta" < 0 AND "counterSaleId" IS NOT NULL AND "reversesMovementId" IS NOT NULL)
) NOT VALID;

COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE pharmacy_stock_movements VALIDATE CONSTRAINT pharmacy_stock_movements_counter_sale_fkey;
ALTER TABLE pharmacy_stock_movements VALIDATE CONSTRAINT pharmacy_stock_movements_direction_check;
COMMIT;
