BEGIN;

-- DEV-951: 20261110111300_pharmacy_receipt_print_cutover gave every receipt issued before the
-- cutover a print state of copyCount 1 (its original already spent), with only
-- app.is_platform_admin set. pharmacy_sales forces row-level security with a tenant-only
-- policy, so a NOSUPERUSER NOBYPASSRLS migration owner saw no sales and inserted nothing. This
-- inserts those states again, one organization at a time with app.current_organization_id set.
--
-- Since the cutover, the issue trigger gives every newly issued receipt a state (copyCount 0)
-- and the first print of a receipt with no state records copyCount 2. A numbered receipt with
-- no state was therefore issued before the cutover and not printed since. A receipt that
-- already has a state is never altered. Re-running changes nothing.
SELECT set_config('app.is_platform_admin', 'true', true);

DO $$
DECLARE
  tenant_id TEXT;
BEGIN
  FOR tenant_id IN SELECT "id" FROM "organizations" ORDER BY "id" LOOP
    PERFORM set_config('app.current_organization_id', tenant_id, true);
    PERFORM set_config('app.current_branch_id', '', true);
    INSERT INTO "pharmacy_receipt_print_states"
      ("id", "organizationId", "branchId", "saleId", "copyCount", "updatedAt")
    SELECT 'receipt_print_' || sale."id", sale."organizationId", sale."branchId", sale."id", 1, NOW()
    FROM "pharmacy_sales" AS sale
    WHERE sale."organizationId" = tenant_id
      AND sale."receiptNumber" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "pharmacy_receipt_print_states" AS state
        WHERE state."organizationId" = sale."organizationId"
          AND state."branchId" = sale."branchId"
          AND state."saleId" = sale."id"
      )
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.current_organization_id', '', true);
END $$;

COMMIT;
