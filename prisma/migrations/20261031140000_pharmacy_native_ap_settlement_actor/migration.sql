BEGIN;

-- Retain the actor on native payments, including payments recorded before this migration.
ALTER TABLE "pharmacy_supplier_expense_settlements" ADD COLUMN "createdByUserId" TEXT;
-- Both tables force RLS; backfill every tenant using the migration-only scope.
SELECT set_config('app.is_platform_admin', 'true', true);
UPDATE "pharmacy_supplier_expense_settlements" s
SET "createdByUserId" = t."createdByUserId"
FROM "pharmacy_bookkeeping_transactions" t
WHERE t."organizationId" = s."organizationId" AND t.id = s."bookkeepingTransactionId";
ALTER TABLE "pharmacy_supplier_expense_settlements" ALTER COLUMN "createdByUserId" SET NOT NULL;

COMMIT;
