BEGIN;

-- DEV-764: one loyalty balance per customer across every branch of a pharmacy organization, an
-- audited record of the per-branch balances it merged, and loyalty membership (enrol and
-- deactivate). Additive only: no points entry is updated or deleted, so every customer's
-- points (the sum of their entries) are exactly what they were before; they now count as one
-- balance instead of one balance per branch.

-- The ledger forces RLS, including for a NOSUPERUSER/NOBYPASSRLS owner. Keep administrative
-- scope local to this transaction, for the reconciliation record below.
SELECT set_config('app.is_platform_admin', 'true', true);

-- Entries posted while balances were kept per branch are marked: a spend among them took only
-- from lots of its own branch, and the expiry planner keeps replaying it that way so no expiry
-- already posted is planned again. Every entry posted from now on takes the column default
-- (false): it spends from the customer's points at any branch of the organization.
ALTER TABLE "pharmacy_loyalty_points_entries"
  ADD COLUMN IF NOT EXISTS "branchLocal" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "pharmacy_loyalty_points_entries"
  ALTER COLUMN "branchLocal" SET DEFAULT false;

-- Customer-wide reads (balance, history, expiry) no longer filter on the branch.
CREATE INDEX IF NOT EXISTS "pharmacy_loyalty_points_entries_customer_idx"
  ON "pharmacy_loyalty_points_entries" ("organizationId", "customerId", "occurredAt");

-- The reconciliation: for every customer who held points at more than one branch, what each
-- branch's balance was when they were merged into one. Append-only, never edited.
CREATE TABLE IF NOT EXISTS "pharmacy_loyalty_balance_reconciliations" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "customerId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "points" INTEGER NOT NULL,
  "entries" INTEGER NOT NULL,
  "reconciledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_loyalty_balance_reconciliations_customer_fkey"
    FOREIGN KEY ("organizationId", "customerId")
    REFERENCES "pharmacy_customers" ("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_loyalty_balance_reconciliations_entries_check" CHECK ("entries" > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_loyalty_balance_reconciliations_branch_key"
  ON "pharmacy_loyalty_balance_reconciliations" ("organizationId", "customerId", "branchId");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'pharmacy_loyalty_balance_reconciliations_append_only'
  ) THEN
    CREATE TRIGGER pharmacy_loyalty_balance_reconciliations_append_only
    BEFORE UPDATE OR DELETE ON "pharmacy_loyalty_balance_reconciliations"
    FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
  END IF;
END $$;

ALTER TABLE "pharmacy_loyalty_balance_reconciliations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_loyalty_balance_reconciliations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "pharmacy_loyalty_balance_reconciliations";
CREATE POLICY tenant_isolation ON "pharmacy_loyalty_balance_reconciliations"
  USING (current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

-- Only entries from before the merge count, so a re-run records the same balances. A customer
-- is recorded only within their own organization.
INSERT INTO "pharmacy_loyalty_balance_reconciliations"
  ("organizationId", "customerId", "branchId", "points", "entries")
SELECT e."organizationId", e."customerId", e."branchId", SUM(e."points")::integer, COUNT(*)::integer
FROM "pharmacy_loyalty_points_entries" e
WHERE e."branchLocal" = true
  AND EXISTS (
    SELECT 1 FROM "pharmacy_loyalty_points_entries" other
    WHERE other."organizationId" = e."organizationId"
      AND other."customerId" = e."customerId"
      AND other."branchLocal" = true
      AND other."branchId" <> e."branchId"
  )
GROUP BY e."organizationId", e."customerId", e."branchId"
ON CONFLICT ("organizationId", "customerId", "branchId") DO NOTHING;

-- Loyalty membership, separate from the retail identity (which khata and the customer portal
-- also use). Every existing customer was enrolled when first linked at the counter with
-- consent, so they stay members. A deactivated member keeps their points but neither earns
-- nor spends them until re-enrolled.
ALTER TABLE "pharmacy_customers"
  ADD COLUMN IF NOT EXISTS "loyaltyActive" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "loyaltyStatusChangedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "loyaltyStatusReason" TEXT;
ALTER TABLE "pharmacy_customers"
  DROP CONSTRAINT IF EXISTS "pharmacy_customers_loyalty_status_reason_check",
  ADD CONSTRAINT "pharmacy_customers_loyalty_status_reason_check" CHECK (
    "loyaltyStatusReason" IS NULL OR length(btrim("loyaltyStatusReason")) BETWEEN 3 AND 500
  );

COMMIT;
