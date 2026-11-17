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
 -- The customer's own spend PIN (bcrypt hash only) and its lockout counters.
 "spendPinHash" TEXT, "pinFailedAttempts" INTEGER NOT NULL DEFAULT 0 CHECK ("pinFailedAttempts" >= 0),
 "pinLockedUntil" TIMESTAMP(3),
 UNIQUE ("organizationId", id), UNIQUE ("organizationId", "customerId"),
 FOREIGN KEY ("organizationId", "customerId") REFERENCES pharmacy_customers("organizationId", id) ON DELETE RESTRICT,
 FOREIGN KEY ("organizationId", "tierVersionId") REFERENCES pharmacy_prepaid_tier_versions("organizationId", id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS pharmacy_prepaid_entries (
 id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
 "branchId" TEXT NOT NULL, "accountId" TEXT NOT NULL, sequence INTEGER NOT NULL CHECK (sequence > 0),
 kind TEXT NOT NULL CHECK (kind IN ('PAYMENT','SPEND','RESTORE','REFUND')),
 "amountMinor" INTEGER NOT NULL CHECK ("amountMinor" <> 0), "refundableDeltaMinor" INTEGER NOT NULL,
 "balanceAfterMinor" INTEGER NOT NULL CHECK ("balanceAfterMinor" >= 0),
 "refundableAfterMinor" INTEGER NOT NULL CHECK ("refundableAfterMinor" BETWEEN 0 AND "balanceAfterMinor"),
 "qualifyingAfterMinor" INTEGER NOT NULL CHECK ("qualifyingAfterMinor" >= 0),
 "discountBasisPointsAfter" INTEGER NOT NULL CHECK ("discountBasisPointsAfter" BETWEEN 0 AND 10000),
 "tierBefore" TEXT, "tierAfter" TEXT, "tierVersionId" TEXT, "tierVersionAfterId" TEXT,
 refundable BOOLEAN, "tenderId" TEXT, "refundId" TEXT, "actorId" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("organizationId", id), UNIQUE ("organizationId", "idempotencyKey"),
 UNIQUE ("organizationId", "accountId", sequence),
 FOREIGN KEY ("organizationId", "accountId") REFERENCES pharmacy_prepaid_accounts("organizationId", id) ON DELETE RESTRICT,
 FOREIGN KEY ("organizationId", "branchId") REFERENCES pharmacy_branches("organizationId", id) ON DELETE RESTRICT,
 FOREIGN KEY ("organizationId", "tierVersionId") REFERENCES pharmacy_prepaid_tier_versions("organizationId", id) ON DELETE RESTRICT,
 FOREIGN KEY ("organizationId", "tierVersionAfterId") REFERENCES pharmacy_prepaid_tier_versions("organizationId", id) ON DELETE RESTRICT,
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

-- Deferred reconciliation. At commit an account's money and tier state must equal its ledger:
-- balances are the entry sums, the newest entry's post-state is the account's state, every
-- entry's post-balance is its running total, and every tier transition chains from the previous
-- entry. A balance or tier change without its immutable entry cannot commit.
CREATE OR REPLACE FUNCTION pharmacy_prepaid_reconcile() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_key TEXT; org_key TEXT; acct pharmacy_prepaid_accounts%ROWTYPE;
  total_balance BIGINT; total_refundable BIGINT; entry_count BIGINT; last_sequence INTEGER;
  latest pharmacy_prepaid_entries%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'pharmacy_prepaid_accounts' THEN account_key := NEW.id; ELSE account_key := NEW."accountId"; END IF;
  org_key := NEW."organizationId";
  SELECT * INTO acct FROM pharmacy_prepaid_accounts WHERE id=account_key AND "organizationId"=org_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Prepaid account must reconcile to its ledger'; END IF;
  SELECT COALESCE(SUM("amountMinor"),0), COALESCE(SUM("refundableDeltaMinor"),0), COUNT(*), COALESCE(MAX(sequence),0)
    INTO total_balance, total_refundable, entry_count, last_sequence
    FROM pharmacy_prepaid_entries WHERE "accountId"=account_key AND "organizationId"=org_key;
  IF acct."balanceMinor" <> total_balance OR acct."refundableMinor" <> total_refundable OR entry_count <> last_sequence THEN
    RAISE EXCEPTION 'Prepaid account must reconcile to its ledger';
  END IF;
  IF entry_count = 0 THEN
    IF acct."qualifyingMinor" <> 0 OR acct."tierName" IS NOT NULL OR acct."discountBasisPoints" <> 0 OR acct."tierVersionId" IS NOT NULL THEN
      RAISE EXCEPTION 'Prepaid tier change requires a ledger entry';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO latest FROM pharmacy_prepaid_entries
    WHERE "accountId"=account_key AND "organizationId"=org_key AND sequence=last_sequence;
  IF (latest."balanceAfterMinor", latest."refundableAfterMinor") IS DISTINCT FROM (acct."balanceMinor", acct."refundableMinor") THEN
    RAISE EXCEPTION 'Prepaid entry balance must match its ledger position';
  END IF;
  IF (latest."qualifyingAfterMinor", latest."tierAfter", latest."discountBasisPointsAfter", latest."tierVersionAfterId")
     IS DISTINCT FROM (acct."qualifyingMinor", acct."tierName", acct."discountBasisPoints", acct."tierVersionId") THEN
    RAISE EXCEPTION 'Prepaid tier change requires a ledger entry';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT e."balanceAfterMinor", e."refundableAfterMinor", e."tierBefore",
        SUM(e."amountMinor") OVER w AS running_balance,
        SUM(e."refundableDeltaMinor") OVER w AS running_refundable,
        LAG(e."tierAfter") OVER w AS previous_tier
      FROM pharmacy_prepaid_entries e
      WHERE e."accountId"=account_key AND e."organizationId"=org_key
      WINDOW w AS (ORDER BY e.sequence)
    ) chain
    WHERE chain."balanceAfterMinor" <> chain.running_balance
      OR chain."refundableAfterMinor" <> chain.running_refundable
      OR chain."tierBefore" IS DISTINCT FROM chain.previous_tier
  ) THEN
    RAISE EXCEPTION 'Prepaid entry balance must match its ledger position';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pharmacy_prepaid_account_reconcile ON pharmacy_prepaid_accounts;
CREATE CONSTRAINT TRIGGER pharmacy_prepaid_account_reconcile AFTER INSERT OR UPDATE ON pharmacy_prepaid_accounts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pharmacy_prepaid_reconcile();
DROP TRIGGER IF EXISTS pharmacy_prepaid_entry_reconcile ON pharmacy_prepaid_entries;
CREATE CONSTRAINT TRIGGER pharmacy_prepaid_entry_reconcile AFTER INSERT ON pharmacy_prepaid_entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pharmacy_prepaid_reconcile();

-- Tier price evidence. Original allocation rows stay append-only; the tier share per allocation
-- lives in its own snapshot on the line.
ALTER TABLE pharmacy_sale_lines DROP CONSTRAINT IF EXISTS pharmacy_prepaid_line_check;
ALTER TABLE pharmacy_sale_lines ADD CONSTRAINT pharmacy_prepaid_line_check
 CHECK ("tierDiscountMinor" >= 0 AND "tierDiscountMinor" <= "discountMinor"
   AND ("tierDiscountMinor" = 0) = ("tierName" IS NULL)
   AND ("tierDiscountMinor" = 0) = ("tierAllocationDiscounts" IS NULL));
-- Frozen evidence never changes once written.
CREATE OR REPLACE FUNCTION pharmacy_prepaid_freeze_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD."tierDiscountMinor" > 0 AND (NEW."tierDiscountMinor", NEW."tierName", NEW."tierAllocationDiscounts", NEW."discountMinor", NEW."grossMinor") IS DISTINCT FROM
   (OLD."tierDiscountMinor", OLD."tierName", OLD."tierAllocationDiscounts", OLD."discountMinor", OLD."grossMinor") THEN
   RAISE EXCEPTION 'Prepaid discount evidence is immutable';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pharmacy_prepaid_freeze_line ON pharmacy_sale_lines;
CREATE TRIGGER pharmacy_prepaid_freeze_line BEFORE UPDATE ON pharmacy_sale_lines
FOR EACH ROW EXECUTE FUNCTION pharmacy_prepaid_freeze_line();
-- Checked at commit, on insert and update alike: a line is written before its allocations, so the
-- completed allocation snapshot is only visible at transaction end. Reads the committed row state.
CREATE OR REPLACE FUNCTION pharmacy_prepaid_check_line_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line pharmacy_sale_lines%ROWTYPE; total BIGINT;
BEGIN
 SELECT * INTO line FROM pharmacy_sale_lines WHERE id=NEW.id AND "organizationId"=NEW."organizationId";
 IF NOT FOUND OR line."tierDiscountMinor" = 0 THEN RETURN NULL; END IF;
 IF line."tierName" IS NULL OR line."tierAllocationDiscounts" IS NULL OR jsonb_typeof(line."tierAllocationDiscounts") <> 'object' THEN
   RAISE EXCEPTION 'Prepaid discount requires allocation evidence';
 END IF;
 SELECT SUM(value::bigint) INTO total FROM jsonb_each_text(line."tierAllocationDiscounts");
 IF total IS DISTINCT FROM line."tierDiscountMinor"::bigint OR EXISTS (
   SELECT 1 FROM jsonb_each_text(line."tierAllocationDiscounts") d
   LEFT JOIN pharmacy_sale_line_allocations a ON a.id=d.key AND a."organizationId"=line."organizationId" AND a."saleLineId"=line.id
   LEFT JOIN pharmacy_inventory_lots l ON l.id=a."inventoryLotId" AND l."organizationId"=a."organizationId"
   WHERE a.id IS NULL OR l.id IS NULL OR d.value::bigint < 0 OR a."grossMinor" IS NULL OR a."discountMinor" IS NULL
     OR a."grossMinor"::bigint-a."discountMinor"::bigint-d.value::bigint < l."unitCostMinor"::bigint*a."canonicalUnits"::bigint
 ) THEN RAISE EXCEPTION 'Prepaid discount exceeds allocation price floor'; END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS pharmacy_prepaid_line_evidence ON pharmacy_sale_lines;
CREATE CONSTRAINT TRIGGER pharmacy_prepaid_line_evidence AFTER INSERT OR UPDATE ON pharmacy_sale_lines
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW."tierDiscountMinor" > 0)
EXECUTE FUNCTION pharmacy_prepaid_check_line_evidence();

COMMIT;
