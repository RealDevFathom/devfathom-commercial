BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE pharmacy_medicines ADD COLUMN IF NOT EXISTS "wholePackOnly" boolean NOT NULL DEFAULT false;
ALTER TABLE pharmacy_stock_movements ADD COLUMN IF NOT EXISTS "counterSaleId" text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid = 'pharmacy_stock_movements'::regclass
    AND conname = 'pharmacy_stock_movements_counter_sale_fkey') THEN
    ALTER TABLE pharmacy_stock_movements ADD CONSTRAINT pharmacy_stock_movements_counter_sale_fkey
      FOREIGN KEY ("organizationId", "branchId", "counterSaleId")
      REFERENCES pharmacy_sales ("organizationId", "branchId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
END $$;
COMMIT;
