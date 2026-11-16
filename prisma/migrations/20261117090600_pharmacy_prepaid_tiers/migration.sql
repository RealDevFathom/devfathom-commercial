BEGIN;
ALTER TYPE "FinanceAccountCode" ADD VALUE IF NOT EXISTS 'CUSTOMER_PREPAID';
ALTER TYPE "FinanceSourceKind" ADD VALUE IF NOT EXISTS 'PHARMACY_PREPAID';
ALTER TABLE pharmacy_sale_lines ADD COLUMN IF NOT EXISTS "tierDiscountMinor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "tierName" TEXT,
  ADD COLUMN IF NOT EXISTS "tierAllocationDiscounts" JSONB;
CREATE TABLE IF NOT EXISTS pharmacy_prepaid_tier_versions (
 id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true) REFERENCES organizations(id),
 version INTEGER NOT NULL CHECK (version > 0), tiers JSONB NOT NULL CHECK (jsonb_typeof(tiers) = 'array'),
 refundable BOOLEAN NOT NULL, "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "actorId" TEXT NOT NULL,
 UNIQUE ("organizationId", id), UNIQUE ("organizationId", version)
);
CREATE TABLE IF NOT EXISTS pharmacy_prepaid_accounts (
 id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
 "customerId" TEXT NOT NULL, "balanceMinor" INTEGER NOT NULL DEFAULT 0 CHECK ("balanceMinor" >= 0),
 "refundableMinor" INTEGER NOT NULL DEFAULT 0 CHECK ("refundableMinor" BETWEEN 0 AND "balanceMinor"),
 "qualifyingMinor" INTEGER NOT NULL DEFAULT 0 CHECK ("qualifyingMinor" >= 0),
 "tierName" TEXT, "discountBasisPoints" INTEGER NOT NULL DEFAULT 0 CHECK ("discountBasisPoints" BETWEEN 0 AND 10000), "tierVersionId" TEXT,
 UNIQUE ("organizationId", id), UNIQUE ("organizationId", "customerId"),
 FOREIGN KEY ("organizationId", "customerId") REFERENCES pharmacy_customers("organizationId", id) ON DELETE RESTRICT,
 FOREIGN KEY ("organizationId", "tierVersionId") REFERENCES pharmacy_prepaid_tier_versions("organizationId", id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS pharmacy_prepaid_entries (
 id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
 "branchId" TEXT NOT NULL, "accountId" TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('PAYMENT','SPEND','RESTORE','REFUND')),
 "amountMinor" INTEGER NOT NULL CHECK ("amountMinor" <> 0), "refundableDeltaMinor" INTEGER NOT NULL,
 "balanceAfterMinor" INTEGER NOT NULL CHECK ("balanceAfterMinor" >= 0), "tierBefore" TEXT, "tierAfter" TEXT, "tierVersionId" TEXT,
 refundable BOOLEAN, "tenderId" TEXT, "refundId" TEXT, "actorId" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("organizationId", id), UNIQUE ("organizationId", "idempotencyKey"),
 FOREIGN KEY ("organizationId", "accountId") REFERENCES pharmacy_prepaid_accounts("organizationId", id) ON DELETE RESTRICT,
 FOREIGN KEY ("organizationId", "branchId") REFERENCES pharmacy_branches("organizationId", id) ON DELETE RESTRICT,
 FOREIGN KEY ("organizationId", "tierVersionId") REFERENCES pharmacy_prepaid_tier_versions("organizationId", id) ON DELETE RESTRICT,
 FOREIGN KEY ("organizationId", "tenderId") REFERENCES pharmacy_tenders("organizationId", id) ON DELETE RESTRICT,
 FOREIGN KEY ("organizationId", "refundId") REFERENCES pharmacy_refunds("organizationId", id) ON DELETE RESTRICT,
 CHECK ((kind IN ('PAYMENT','RESTORE') AND "amountMinor" > 0) OR (kind IN ('SPEND','REFUND') AND "amountMinor" < 0))
);
CREATE INDEX IF NOT EXISTS pharmacy_prepaid_entries_account_idx ON pharmacy_prepaid_entries("organizationId", "accountId", "createdAt");
ALTER TABLE pharmacy_prepaid_tier_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_prepaid_tier_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON pharmacy_prepaid_tier_versions;
CREATE POLICY tenant_isolation ON pharmacy_prepaid_tier_versions USING ("organizationId" = current_setting('app.current_organization_id', true)) WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));
ALTER TABLE pharmacy_prepaid_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_prepaid_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON pharmacy_prepaid_accounts;
CREATE POLICY tenant_isolation ON pharmacy_prepaid_accounts USING ("organizationId" = current_setting('app.current_organization_id', true)) WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));
ALTER TABLE pharmacy_prepaid_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_prepaid_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON pharmacy_prepaid_entries;
CREATE POLICY tenant_isolation ON pharmacy_prepaid_entries USING ("organizationId" = current_setting('app.current_organization_id', true)) WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));
DROP TRIGGER IF EXISTS pharmacy_prepaid_tier_versions_append_only ON pharmacy_prepaid_tier_versions;
CREATE TRIGGER pharmacy_prepaid_tier_versions_append_only BEFORE UPDATE OR DELETE ON pharmacy_prepaid_tier_versions
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
DROP TRIGGER IF EXISTS pharmacy_prepaid_entries_append_only ON pharmacy_prepaid_entries;
CREATE TRIGGER pharmacy_prepaid_entries_append_only BEFORE UPDATE OR DELETE ON pharmacy_prepaid_entries
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();

-- Deferred reconciliation: an account mutation cannot commit without its matching ledger movement.
CREATE OR REPLACE FUNCTION pharmacy_prepaid_reconcile() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_key TEXT; org_key TEXT; balance BIGINT; refundable BIGINT; actual_balance INTEGER; actual_refundable INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'pharmacy_prepaid_accounts' THEN account_key := NEW.id; ELSE account_key := NEW."accountId"; END IF;
  org_key := NEW."organizationId";
  SELECT "balanceMinor", "refundableMinor" INTO actual_balance, actual_refundable FROM pharmacy_prepaid_accounts
    WHERE id=account_key AND "organizationId"=org_key FOR UPDATE;
  SELECT COALESCE(SUM("amountMinor"),0), COALESCE(SUM("refundableDeltaMinor"),0) INTO balance, refundable
    FROM pharmacy_prepaid_entries WHERE "accountId"=account_key AND "organizationId"=org_key;
  IF actual_balance IS DISTINCT FROM balance OR actual_refundable IS DISTINCT FROM refundable THEN
    RAISE EXCEPTION 'Prepaid account must reconcile to its ledger';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pharmacy_prepaid_account_reconcile ON pharmacy_prepaid_accounts;
CREATE CONSTRAINT TRIGGER pharmacy_prepaid_account_reconcile AFTER INSERT OR UPDATE ON pharmacy_prepaid_accounts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pharmacy_prepaid_reconcile();
DROP TRIGGER IF EXISTS pharmacy_prepaid_entry_reconcile ON pharmacy_prepaid_entries;
CREATE CONSTRAINT TRIGGER pharmacy_prepaid_entry_reconcile AFTER INSERT ON pharmacy_prepaid_entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pharmacy_prepaid_reconcile();
-- Tier evidence is written once at first payment. Original allocation rows stay append-only.
ALTER TABLE pharmacy_sale_lines DROP CONSTRAINT IF EXISTS pharmacy_prepaid_line_check;
ALTER TABLE pharmacy_sale_lines ADD CONSTRAINT pharmacy_prepaid_line_check
 CHECK ("tierDiscountMinor" >= 0 AND "tierDiscountMinor" <= "discountMinor");
CREATE OR REPLACE FUNCTION pharmacy_prepaid_guard_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total BIGINT;
BEGIN
 IF OLD."tierDiscountMinor" > 0 AND (NEW."tierDiscountMinor", NEW."tierName", NEW."tierAllocationDiscounts", NEW."discountMinor") IS DISTINCT FROM
   (OLD."tierDiscountMinor", OLD."tierName", OLD."tierAllocationDiscounts", OLD."discountMinor") THEN
   RAISE EXCEPTION 'Prepaid discount evidence is immutable';
 END IF;
 IF NEW."tierDiscountMinor" > 0 THEN
   IF NEW."tierName" IS NULL OR NEW."tierAllocationDiscounts" IS NULL OR jsonb_typeof(NEW."tierAllocationDiscounts") <> 'object' THEN
     RAISE EXCEPTION 'Prepaid discount requires allocation evidence';
   END IF;
   SELECT SUM(value::bigint) INTO total FROM jsonb_each_text(NEW."tierAllocationDiscounts");
   IF total IS DISTINCT FROM NEW."tierDiscountMinor"::bigint OR EXISTS (
     SELECT 1 FROM jsonb_each_text(NEW."tierAllocationDiscounts") d
     LEFT JOIN pharmacy_sale_line_allocations a ON a.id=d.key AND a."organizationId"=NEW."organizationId" AND a."saleLineId"=NEW.id
     LEFT JOIN pharmacy_inventory_lots l ON l.id=a."inventoryLotId" AND l."organizationId"=a."organizationId"
     WHERE a.id IS NULL OR d.value::bigint < 0 OR a."grossMinor" IS NULL OR a."discountMinor" IS NULL
       OR a."grossMinor"::bigint-a."discountMinor"::bigint-d.value::bigint < l."unitCostMinor"::bigint*a."canonicalUnits"::bigint
   ) THEN RAISE EXCEPTION 'Prepaid discount exceeds allocation price floor'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pharmacy_prepaid_guard_line ON pharmacy_sale_lines;
CREATE TRIGGER pharmacy_prepaid_guard_line BEFORE UPDATE ON pharmacy_sale_lines
FOR EACH ROW EXECUTE FUNCTION pharmacy_prepaid_guard_line();

COMMIT;
