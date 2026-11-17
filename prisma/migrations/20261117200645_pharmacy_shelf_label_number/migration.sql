-- DEV-90: shelf and price stickers for unbarcoded or loose stock.
-- Each inventory lot gets a compact numeric alias that the internal Code128 on
-- its sticker encodes, so a 38 mm thermal label stays scannable. Existing lots
-- are numbered by the backfill; new lots take the next number from the column
-- default. IDs, receipt evidence, MRP, stock and the table's RLS policies are
-- unchanged, and every lookup stays organization and branch scoped.
-- Idempotent: safe to re-run.
BEGIN;

-- The table forces RLS, including for its owner. Keep administrative scope
-- local to this transaction so the backfill can number every tenant's lots.
SELECT set_config('app.is_platform_admin', 'true', true);

CREATE SEQUENCE IF NOT EXISTS "pharmacy_inventory_lots_shelfLabelNumber_seq" AS INTEGER;

ALTER TABLE "pharmacy_inventory_lots" ADD COLUMN IF NOT EXISTS "shelfLabelNumber" INTEGER;

ALTER TABLE "pharmacy_inventory_lots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_inventory_lots" FORCE ROW LEVEL SECURITY;

UPDATE "pharmacy_inventory_lots"
SET "shelfLabelNumber" = nextval('"pharmacy_inventory_lots_shelfLabelNumber_seq"')
WHERE "shelfLabelNumber" IS NULL;

ALTER TABLE "pharmacy_inventory_lots"
  ALTER COLUMN "shelfLabelNumber" SET DEFAULT nextval('"pharmacy_inventory_lots_shelfLabelNumber_seq"'),
  ALTER COLUMN "shelfLabelNumber" SET NOT NULL;

ALTER SEQUENCE "pharmacy_inventory_lots_shelfLabelNumber_seq"
  OWNED BY "pharmacy_inventory_lots"."shelfLabelNumber";

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_inventory_lots_shelfLabelNumber_key"
  ON "pharmacy_inventory_lots"("shelfLabelNumber");

-- A printed sticker must keep resolving to the same lot for its whole shelf life.
CREATE OR REPLACE FUNCTION pharmacy_shelf_label_number_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."shelfLabelNumber" IS DISTINCT FROM OLD."shelfLabelNumber" THEN
    RAISE EXCEPTION 'pharmacy lot shelf label number is immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pharmacy_shelf_label_number_immutable ON "pharmacy_inventory_lots";
CREATE TRIGGER pharmacy_shelf_label_number_immutable
  BEFORE UPDATE OF "shelfLabelNumber" ON "pharmacy_inventory_lots"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_shelf_label_number_immutable();

COMMIT;
