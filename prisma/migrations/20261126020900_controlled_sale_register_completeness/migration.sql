BEGIN;
SET LOCAL lock_timeout = '5s';

-- Starting from the line also covers transactions that omit the review, audit
-- and register altogether. Existing register rules validate the chosen approval.
CREATE OR REPLACE FUNCTION pharmacy_require_controlled_sale_register() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE is_controlled boolean;
BEGIN
  SELECT m.controlled INTO is_controlled FROM pharmacy_medicines m
   WHERE m.id=NEW."medicineId" AND m."organizationId"=NEW."organizationId" FOR SHARE;
  IF is_controlled IS FALSE THEN RETURN NULL; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pharmacy_sale_line_allocations al
    LEFT JOIN pharmacy_controlled_register_entries r
      ON r."organizationId"=al."organizationId" AND r."branchId"=al."branchId"
      AND r."stockMovementId"=al."stockMovementId" AND r."inventoryLotId"=al."inventoryLotId"
      AND r."medicineId"=NEW."medicineId" AND r."entryKind"='SALE'
      AND r."quantityCanonicalUnits"=al."canonicalUnits"
      AND r.xmin=pg_current_xact_id()::xid
    WHERE al."organizationId"=NEW."organizationId" AND al."saleLineId"=NEW.id AND al."branchId"=NEW."branchId"
    GROUP BY al."saleLineId"
    HAVING sum(al."canonicalUnits")=NEW."canonicalUnits" AND count(*)=count(r.id)
  ) THEN
    RAISE EXCEPTION 'controlled sale line requires its approved register entries' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS pharmacy_require_controlled_sale_register ON pharmacy_sale_lines;
CREATE CONSTRAINT TRIGGER pharmacy_require_controlled_sale_register AFTER INSERT ON pharmacy_sale_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pharmacy_require_controlled_sale_register();

COMMIT;
