-- DEV-774: purchasing quantities/costs and stock-movement quantities must be
-- finite. PostgreSQL numeric accepts 'NaN' even in DECIMAL(18,6) columns, and
-- NaN sorts above every number, so the existing ">= 0" CHECKs let it through and
-- a single NaN movement poisons every derived on-hand balance. These CHECKs
-- protect direct writes alongside the application-level validation.
--
-- Refuse to guess how legacy non-finite stock or purchasing rows should be
-- repaired (the stock ledger is append-only): report a bounded set of affected
-- tenant/record IDs and let the migration be retried after an approved repair.
-- Idempotent: each constraint is dropped if present before being re-added.
BEGIN;

DO $$
DECLARE
  affected jsonb;
BEGIN
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'stockMovements', (SELECT jsonb_agg(row_to_json(bad)) FROM (
      SELECT "organizationId", "id" FROM "restaurant_stock_movements"
      WHERE "quantity" IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
        OR "unitCost" IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) LIMIT 20
    ) bad),
    'purchaseOrderLines', (SELECT jsonb_agg(row_to_json(bad)) FROM (
      SELECT "organizationId", "id" FROM "restaurant_purchase_order_lines"
      WHERE "orderedQuantity" IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
        OR "unitCost" IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) LIMIT 20
    ) bad),
    'purchaseReceiptLines', (SELECT jsonb_agg(row_to_json(bad)) FROM (
      SELECT "organizationId", "id" FROM "restaurant_purchase_receipt_lines"
      WHERE "receivedQuantity" IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
        OR "unitCost" IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) LIMIT 20
    ) bad),
    'receivingDiscrepancies', (SELECT jsonb_agg(row_to_json(bad)) FROM (
      SELECT "organizationId", "id" FROM "restaurant_receiving_discrepancies"
      WHERE "expectedQuantity" IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
        OR "receivedQuantity" IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) LIMIT 20
    ) bad)
  )) INTO affected;

  IF affected <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Restaurant purchasing finite-decimal constraints cannot be installed: invalid legacy rows exist'
      USING DETAIL = affected::text,
            HINT = 'Repair the listed rows according to an approved business rule, then retry this migration.';
  END IF;
END $$;

ALTER TABLE "restaurant_stock_movements"
  DROP CONSTRAINT IF EXISTS "restaurant_stock_movements_finite_ck";
ALTER TABLE "restaurant_stock_movements"
  ADD CONSTRAINT "restaurant_stock_movements_finite_ck"
  CHECK ("quantity" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND
    ("unitCost" IS NULL OR "unitCost" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)));

ALTER TABLE "restaurant_purchase_order_lines"
  DROP CONSTRAINT IF EXISTS "restaurant_purchase_order_lines_finite_ck";
ALTER TABLE "restaurant_purchase_order_lines"
  ADD CONSTRAINT "restaurant_purchase_order_lines_finite_ck"
  CHECK ("orderedQuantity" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND
    "unitCost" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric));

ALTER TABLE "restaurant_purchase_receipt_lines"
  DROP CONSTRAINT IF EXISTS "restaurant_purchase_receipt_lines_finite_ck";
ALTER TABLE "restaurant_purchase_receipt_lines"
  ADD CONSTRAINT "restaurant_purchase_receipt_lines_finite_ck"
  CHECK ("receivedQuantity" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND
    "unitCost" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric));

ALTER TABLE "restaurant_receiving_discrepancies"
  DROP CONSTRAINT IF EXISTS "restaurant_receiving_discrepancies_finite_ck";
ALTER TABLE "restaurant_receiving_discrepancies"
  ADD CONSTRAINT "restaurant_receiving_discrepancies_finite_ck"
  CHECK ("expectedQuantity" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND
    "receivedQuantity" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric));

COMMIT;
