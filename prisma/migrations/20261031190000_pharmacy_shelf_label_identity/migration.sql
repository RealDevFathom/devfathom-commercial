-- #719: shelf and price labels for unbarcoded or loose stock.
-- A compact numeric alias keeps the internal Code128 short enough to scan on
-- 38 mm thermal stock. SERIAL backfills existing lots and numbers future lots
-- without changing their IDs, receipt evidence, MRP, stock, or the existing
-- RLS policies and triggers. Lookups are always organization + branch scoped.
ALTER TABLE "pharmacy_inventory_lots" ADD COLUMN "shelfLabelNumber" SERIAL NOT NULL;
CREATE UNIQUE INDEX "pharmacy_inventory_lots_shelfLabelNumber_key"
  ON "pharmacy_inventory_lots"("shelfLabelNumber");
ALTER TABLE "pharmacy_inventory_lots" ADD CONSTRAINT "pharmacy_lot_label_positive"
  CHECK ("shelfLabelNumber" > 0);

-- A printed label must keep resolving to the same lot for its whole shelf life.
CREATE FUNCTION pharmacy_shelf_label_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."shelfLabelNumber" IS DISTINCT FROM OLD."shelfLabelNumber" THEN
    RAISE EXCEPTION 'Shelf label lot identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_shelf_label_identity_immutable
  BEFORE UPDATE ON "pharmacy_inventory_lots"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_shelf_label_identity_immutable();
