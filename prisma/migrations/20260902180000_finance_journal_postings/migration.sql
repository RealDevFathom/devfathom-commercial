-- FIN-01 / FIN-03 / §8A invariant 15 — the shared double-entry journal.
--
-- Every guarantee the posting adapters rely on is enforced here rather than in
-- application code, because "balanced", "append-only" and "reversal is additive"
-- are claims about what the database will accept, not about what one code path
-- happens to do:
--
--   * balanced        — a DEFERRABLE INITIALLY DEFERRED constraint trigger, so
--                       the check runs once at COMMIT and an adapter may write
--                       its debit and its credit as separate statements.
--   * append-only     — UPDATE and DELETE raise on both tables.
--   * reversal        — additive only: a reversal is a NEW entry naming the one
--                       it cancels, its lines are the original's with the sides
--                       swapped, and each entry may be reversed at most once.
--   * traceable       — sourceKind + sourceId are NOT NULL on every entry.
--   * tenant isolated — FORCE ROW LEVEL SECURITY on both tables.

-- CreateEnum
CREATE TYPE "FinanceJournalSide" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "FinanceAccountCode" AS ENUM ('INVENTORY', 'INVENTORY_IN_TRANSIT', 'GOODS_RECEIVED_ACCRUAL', 'SALES_CLEARING', 'SALES_REVENUE', 'SALES_DISCOUNT', 'COST_OF_GOODS_SOLD', 'INVENTORY_WRITE_OFF', 'INVENTORY_SHRINKAGE', 'SUPPLIER_CLAIM_RECEIVABLE', 'CASH', 'BANK', 'ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE', 'CASH_OVER_SHORT', 'OPENING_BALANCE_EQUITY');

-- CreateEnum
CREATE TYPE "FinanceSourceKind" AS ENUM ('PHARMACY_GOODS_RECEIPT', 'PHARMACY_SALE_LINE', 'PHARMACY_SALE_RETURN_LINE', 'PHARMACY_STOCK_WRITE_OFF', 'PHARMACY_SUPPLIER_CLAIM', 'PHARMACY_INTERBRANCH_TRANSFER_LINE', 'PHARMACY_INVENTORY_COUNT_LINE', 'PHARMACY_TENDER', 'PHARMACY_REFUND', 'PHARMACY_DAILY_CLOSE', 'PHARMACY_OPENING_STOCK', 'PHARMACY_OPENING_LEDGER');

-- CreateTable
CREATE TABLE "finance_journal_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT,
    "sourceKind" "FinanceSourceKind" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'PKR',
    "actorId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "reversesEntryId" TEXT,
    "reversalReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_journal_lines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "entryId" TEXT NOT NULL,
    "accountCode" "FinanceAccountCode" NOT NULL,
    "side" "FinanceJournalSide" NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "branchId" TEXT,
    "productId" TEXT,
    "lotId" TEXT,
    "locationId" TEXT,
    "sourceLineId" TEXT,
    "memo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "finance_journal_entries_org_id_key" ON "finance_journal_entries"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_journal_entries_org_idempotency_key" ON "finance_journal_entries"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "finance_journal_entries_org_reverses_key" ON "finance_journal_entries"("organizationId", "reversesEntryId");

-- CreateIndex
CREATE INDEX "finance_journal_entries_org_source_idx" ON "finance_journal_entries"("organizationId", "sourceKind", "sourceId");

-- CreateIndex
CREATE INDEX "finance_journal_entries_org_branch_occurred_idx" ON "finance_journal_entries"("organizationId", "branchId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "finance_journal_lines_org_id_key" ON "finance_journal_lines"("organizationId", "id");

-- CreateIndex
CREATE INDEX "finance_journal_lines_org_entry_idx" ON "finance_journal_lines"("organizationId", "entryId");

-- CreateIndex
CREATE INDEX "finance_journal_lines_org_account_branch_idx" ON "finance_journal_lines"("organizationId", "accountCode", "branchId");

-- CreateIndex
CREATE INDEX "finance_journal_lines_org_lot_location_idx" ON "finance_journal_lines"("organizationId", "lotId", "locationId");

-- AddForeignKey
ALTER TABLE "finance_journal_entries" ADD CONSTRAINT "finance_journal_entries_reverses_fkey" FOREIGN KEY ("organizationId", "reversesEntryId") REFERENCES "finance_journal_entries"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_journal_lines" ADD CONSTRAINT "finance_journal_lines_entry_fkey" FOREIGN KEY ("organizationId", "entryId") REFERENCES "finance_journal_entries"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Direction lives in `side`; an amount is a magnitude and is never signed, and a
-- zero leg carries no information a missing leg does not.
ALTER TABLE "finance_journal_lines" ADD CONSTRAINT "finance_journal_lines_amount_positive" CHECK ("amountMinor" > 0);

-- A reversal names the entry it cancels AND says why; a normal entry does
-- neither. Half of a reversal is not a reversal.
--
-- COALESCE is load-bearing: a CHECK evaluating to NULL PASSES, so
-- `btrim("reversalReason") <> ''` would accept exactly the case this refuses —
-- a reversal with no reason at all.
ALTER TABLE "finance_journal_entries" ADD CONSTRAINT "finance_journal_entries_reversal_reason" CHECK (
  ("reversesEntryId" IS NULL AND "reversalReason" IS NULL)
  OR ("reversesEntryId" IS NOT NULL AND COALESCE(btrim("reversalReason"), '') <> '')
);

-- Debits = credits, checked once at COMMIT.
--
-- Per-statement checking would make the primitive unusable: the first leg of any
-- entry is unbalanced by construction. DEFERRABLE INITIALLY DEFERRED moves the
-- check to the end of the transaction, where the entry is either whole or the
-- whole transaction rolls back. Fired from both tables so that neither "an entry
-- with no lines" nor "lines that do not add up" can commit.
CREATE OR REPLACE FUNCTION finance_assert_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  org text;
  entry text;
  legs int;
  debits bigint;
  credits bigint;
BEGIN
  org := NEW."organizationId";
  -- Branched, not a CASE expression: one function serves two tables whose
  -- records have different fields, and PL/pgSQL resolves every field named in
  -- an expression it prepares — including the branch that will not be taken.
  IF TG_TABLE_NAME = 'finance_journal_entries' THEN
    entry := NEW."id";
  ELSE
    entry := NEW."entryId";
  END IF;

  SELECT COUNT(*),
         COALESCE(SUM(CASE WHEN line."side" = 'DEBIT' THEN line."amountMinor" ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN line."side" = 'CREDIT' THEN line."amountMinor" ELSE 0 END), 0)
    INTO legs, debits, credits
    FROM "finance_journal_lines" line
   WHERE line."organizationId" = org AND line."entryId" = entry;

  -- An entry needs at least one leg on each side, so an entry whose lines were
  -- never written cannot slip through as a vacuous 0 = 0.
  IF legs < 2 THEN
    RAISE EXCEPTION 'FINANCE_ENTRY_INCOMPLETE' USING ERRCODE = '23514';
  END IF;
  IF debits <> credits THEN
    RAISE EXCEPTION 'FINANCE_ENTRY_UNBALANCED' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER finance_journal_entries_balanced
  AFTER INSERT ON "finance_journal_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_assert_entry_balanced();

CREATE CONSTRAINT TRIGGER finance_journal_lines_balanced
  AFTER INSERT ON "finance_journal_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_assert_entry_balanced();

-- §8A invariant 15: "reversal is linked and additive, not destructive". A
-- reversal that were free to post any lines it liked would be a second, silent
-- adjustment wearing a reversal's name, so its lines must be exactly the
-- original's with the sides swapped — same accounts, same amounts, same
-- dimensions. Deferred for the same reason as the balance check.
CREATE OR REPLACE FUNCTION finance_assert_reversal_negates() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mismatched int;
BEGIN
  IF NEW."reversesEntryId" IS NULL THEN RETURN NULL; END IF;

  WITH expected AS (
    SELECT line."accountCode",
           CASE line."side" WHEN 'DEBIT' THEN 'CREDIT'::"FinanceJournalSide" ELSE 'DEBIT'::"FinanceJournalSide" END AS "side",
           line."amountMinor", line."branchId", line."productId",
           line."lotId", line."locationId", line."sourceLineId"
      FROM "finance_journal_lines" line
     WHERE line."organizationId" = NEW."organizationId"
       AND line."entryId" = NEW."reversesEntryId"
  ), actual AS (
    SELECT line."accountCode", line."side", line."amountMinor", line."branchId",
           line."productId", line."lotId", line."locationId", line."sourceLineId"
      FROM "finance_journal_lines" line
     WHERE line."organizationId" = NEW."organizationId"
       AND line."entryId" = NEW."id"
  )
  SELECT COUNT(*) INTO mismatched
    FROM ((TABLE expected EXCEPT ALL TABLE actual) UNION ALL (TABLE actual EXCEPT ALL TABLE expected)) difference;

  IF mismatched <> 0 THEN
    RAISE EXCEPTION 'FINANCE_REVERSAL_NOT_A_NEGATION' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER finance_journal_entries_reversal_negates
  AFTER INSERT ON "finance_journal_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_assert_reversal_negates();

-- Append-only. A posted entry is evidence; correcting it means posting a
-- reversal, never rewriting what was already reported.
CREATE OR REPLACE FUNCTION finance_journal_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FINANCE_JOURNAL_APPEND_ONLY' USING ERRCODE = '23514';
END $$;

CREATE TRIGGER finance_journal_entries_append_only
  BEFORE UPDATE OR DELETE ON "finance_journal_entries"
  FOR EACH ROW EXECUTE FUNCTION finance_journal_append_only();

CREATE TRIGGER finance_journal_lines_append_only
  BEFORE UPDATE OR DELETE ON "finance_journal_lines"
  FOR EACH ROW EXECUTE FUNCTION finance_journal_append_only();

-- Tenant isolation is mandatory on every new organization-owned relation.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['finance_journal_entries','finance_journal_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("organizationId" = current_setting(''app.current_organization_id'', true)) WITH CHECK ("organizationId" = current_setting(''app.current_organization_id'', true))', t);
  END LOOP;
END $$;
