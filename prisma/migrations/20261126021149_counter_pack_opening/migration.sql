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
      REFERENCES pharmacy_sales ("organizationId", "branchId", id) ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
END $$;
COMMIT;
