BEGIN;

-- Use the same transaction lock as closeAccountingPeriod/reopenAccountingPeriod.
-- A separate SELECT after the lock sees a close that committed while we waited.
CREATE OR REPLACE FUNCTION finance_assert_period_open(
  organization_id TEXT, branch_id TEXT, occurred_at TIMESTAMP
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF branch_id IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'pharmacy-ledger:' || organization_id || ':' || branch_id, 0));
  IF EXISTS (
    SELECT 1 FROM pharmacy_accounting_periods p
    WHERE p."organizationId" = organization_id AND p."branchId" = branch_id
      AND p.status = 'CLOSED'
      AND occurred_at >= p."startsAt" AND occurred_at < p."endsAt"
  ) THEN
    RAISE EXCEPTION 'PHARMACY_ACCOUNTING_PERIOD_CLOSED' USING ERRCODE = '23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION finance_journal_period_open() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry_at TIMESTAMP; entry_branch TEXT;
BEGIN
  IF TG_TABLE_NAME = 'finance_journal_entries' THEN
    PERFORM finance_assert_period_open(NEW."organizationId", NEW."branchId", NEW."occurredAt");
  ELSE
    -- Lines can carry a different branch (e.g. inter-branch transfers), including
    -- entries without a header branch. Protect those ledgers at the same date.
    SELECT e."occurredAt", e."branchId" INTO entry_at, entry_branch
      FROM finance_journal_entries e
      WHERE e."organizationId" = NEW."organizationId" AND e.id = NEW."entryId";
    -- A line appended to an existing entry must also obey the header's period,
    -- even if the line has no branch dimension of its own.
    PERFORM finance_assert_period_open(NEW."organizationId", entry_branch, entry_at);
    PERFORM finance_assert_period_open(NEW."organizationId", NEW."branchId", entry_at);
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER finance_journal_entry_period_open
  BEFORE INSERT ON finance_journal_entries
  FOR EACH ROW EXECUTE FUNCTION finance_journal_period_open();
CREATE OR REPLACE TRIGGER finance_journal_line_period_open
  BEFORE INSERT ON finance_journal_lines
  FOR EACH ROW EXECUTE FUNCTION finance_journal_period_open();

-- Direct period writes must serialize too, rather than relying on a particular
-- API caller taking the lock. No existing entries or periods are rewritten.
CREATE OR REPLACE FUNCTION pharmacy_accounting_period_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE branch_scope RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    FOR branch_scope IN
      SELECT DISTINCT org, branch FROM (VALUES
        (OLD."organizationId", OLD."branchId"), (NEW."organizationId", NEW."branchId")
      ) AS scopes(org, branch) ORDER BY org, branch
    LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended(
        'pharmacy-ledger:' || branch_scope.org || ':' || branch_scope.branch, 0));
    END LOOP;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'pharmacy-ledger:' || NEW."organizationId" || ':' || NEW."branchId", 0));
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER pharmacy_accounting_period_ledger_lock
  BEFORE INSERT OR UPDATE ON pharmacy_accounting_periods
  FOR EACH ROW EXECUTE FUNCTION pharmacy_accounting_period_lock();

-- Retain the bookkeeping guard and give direct bookkeeping writes the same lock.
CREATE OR REPLACE FUNCTION pharmacy_assert_bookkeeping_period_open() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'POSTED' AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM 'POSTED') THEN
    PERFORM finance_assert_period_open(NEW."organizationId", NEW."branchId", NEW."occurredAt");
  END IF;
  RETURN NEW;
END $$;

COMMIT;
