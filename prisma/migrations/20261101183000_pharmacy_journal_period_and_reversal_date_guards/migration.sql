-- Closed accounting periods fail closed at the database boundary for pharmacy
-- journal vouchers, mirroring the bookkeeping period trigger. Every check
-- first takes the same per-branch transaction advisory lock the application
-- uses for accounting writes and period close/reopen, so a posting and a
-- concurrent close serialize: whichever commits second sees the other.

CREATE FUNCTION pharmacy_lock_accounting_scope(org text, branch text) RETURNS void AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(org || ':' || branch || ':pharmacy-journal', 0));
END; $$ LANGUAGE plpgsql;

-- Volatile on purpose: it must read periods committed by a concurrent close
-- that finished while this transaction waited on the scope lock.
CREATE FUNCTION pharmacy_accounting_period_closed_at(org text, branch text, instant timestamp(3)) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM "pharmacy_accounting_periods" p
    WHERE p."organizationId" = org AND p."branchId" = branch
      AND p."status" = 'CLOSED' AND instant >= p."startsAt" AND instant < p."endsAt"
  );
$$ LANGUAGE sql VOLATILE;

-- Closing or reopening a period through any path waits for in-flight
-- accounting writes on that branch.
CREATE FUNCTION pharmacy_accounting_period_scope_lock() RETURNS trigger AS $$
BEGIN
  PERFORM pharmacy_lock_accounting_scope(NEW."organizationId", NEW."branchId");
  IF TG_OP = 'UPDATE' AND (OLD."organizationId" IS DISTINCT FROM NEW."organizationId" OR OLD."branchId" IS DISTINCT FROM NEW."branchId") THEN
    PERFORM pharmacy_lock_accounting_scope(OLD."organizationId", OLD."branchId");
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "pharmacy_accounting_periods_scope_lock"
BEFORE INSERT OR UPDATE ON "pharmacy_accounting_periods"
FOR EACH ROW EXECUTE FUNCTION pharmacy_accounting_period_scope_lock();

-- Voucher ledger entries (postings and their additive reversals) cannot be
-- dated inside a closed period of their branch.
CREATE FUNCTION pharmacy_journal_voucher_entry_period_open() RETURNS trigger AS $$
BEGIN
  IF NEW."sourceKind"::text <> 'PHARMACY_JOURNAL_VOUCHER' THEN
    RETURN NEW;
  END IF;
  IF NEW."branchId" IS NULL THEN
    RAISE EXCEPTION 'pharmacy journal voucher postings must name a branch' USING ERRCODE = '23514';
  END IF;
  PERFORM pharmacy_lock_accounting_scope(NEW."organizationId", NEW."branchId");
  IF pharmacy_accounting_period_closed_at(NEW."organizationId", NEW."branchId", NEW."occurredAt") THEN
    RAISE EXCEPTION 'PHARMACY_ACCOUNTING_PERIOD_CLOSED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "finance_journal_entries_pharmacy_voucher_period_open"
BEFORE INSERT ON "finance_journal_entries"
FOR EACH ROW EXECUTE FUNCTION pharmacy_journal_voucher_entry_period_open();

-- Document transitions: posting requires an open period at the voucher date,
-- reversal requires an open period at the reversal date, and the linked
-- reversal ledger entry must carry exactly the recorded reversal date (which
-- the existing check constraint keeps on or after the voucher date).
CREATE FUNCTION pharmacy_general_journal_period_and_reversal_date() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'POSTED' AND OLD.status IS DISTINCT FROM 'POSTED' THEN
    PERFORM pharmacy_lock_accounting_scope(NEW."organizationId", NEW."branchId");
    IF pharmacy_accounting_period_closed_at(NEW."organizationId", NEW."branchId", NEW."occurredAt") THEN
      RAISE EXCEPTION 'PHARMACY_ACCOUNTING_PERIOD_CLOSED' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status = 'REVERSED' AND OLD.status IS DISTINCT FROM 'REVERSED' THEN
    PERFORM pharmacy_lock_accounting_scope(NEW."organizationId", NEW."branchId");
    IF NEW."reversedAt" IS NULL OR NEW."reversedAt" < NEW."occurredAt" THEN
      RAISE EXCEPTION 'pharmacy journal voucher reversal cannot precede the voucher date' USING ERRCODE = '23514';
    END IF;
    IF pharmacy_accounting_period_closed_at(NEW."organizationId", NEW."branchId", NEW."reversedAt") THEN
      RAISE EXCEPTION 'PHARMACY_ACCOUNTING_PERIOD_CLOSED' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "finance_journal_entries" reversal
      WHERE reversal."organizationId" = NEW."organizationId"
        AND reversal.id = NEW."reversalEntryId"
        AND reversal."occurredAt" = NEW."reversedAt"
        AND reversal."occurredAt" >= NEW."occurredAt"
        AND reversal."branchId" = NEW."branchId"
        AND reversal.currency = NEW.currency
    ) THEN
      RAISE EXCEPTION 'pharmacy journal voucher reversal must be dated on its recorded reversal date' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "pharmacy_general_journal_period_and_reversal_date"
BEFORE UPDATE ON "pharmacy_general_journal_documents"
FOR EACH ROW EXECUTE FUNCTION pharmacy_general_journal_period_and_reversal_date();
