BEGIN;

-- Same org+branch lock as the application. Keep this SECURITY INVOKER so all
-- period reads obey the caller's tenant RLS. No historical entry is changed.
CREATE OR REPLACE FUNCTION pharmacy_assert_journal_period_open(
  organization_id text, branch_id text, occurred_at timestamp
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF branch_id IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'pharmacy-ledger:' || organization_id || ':' || branch_id, 0
  ));
  IF EXISTS (
    SELECT 1 FROM pharmacy_accounting_periods p
    WHERE p."organizationId" = organization_id AND p."branchId" = branch_id
      AND p.status = 'CLOSED'
      AND occurred_at >= p."startsAt" AND occurred_at < p."endsAt"
  ) THEN
    RAISE EXCEPTION 'PHARMACY_ACCOUNTING_PERIOD_CLOSED' USING ERRCODE = '23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION pharmacy_journal_entry_period_open()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pharmacy_assert_journal_period_open(NEW."organizationId", NEW."branchId", NEW."occurredAt");
  RETURN NEW;
END $$;

-- A transfer line can affect a second branch, and a line can be appended to an
-- entry that already sits in a closed header period. Check BOTH the header
-- branch and the line branch (never COALESCE one into the other), locking the
-- distinct ledgers in stable order so two writers cannot deadlock.
CREATE OR REPLACE FUNCTION pharmacy_journal_line_period_open()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry_at timestamp; entry_branch text; ledger_branch text;
BEGIN
  SELECT e."occurredAt", e."branchId" INTO entry_at, entry_branch
    FROM finance_journal_entries e
    WHERE e."organizationId" = NEW."organizationId" AND e.id = NEW."entryId";
  FOR ledger_branch IN
    SELECT DISTINCT b COLLATE "C" FROM (VALUES (entry_branch), (NEW."branchId")) AS branches(b)
    WHERE b IS NOT NULL ORDER BY 1
  LOOP
    PERFORM pharmacy_assert_journal_period_open(NEW."organizationId", ledger_branch, entry_at);
  END LOOP;
  RETURN NEW;
END $$;

-- Cover SQL period changes too, so a concurrent close waits for an accepted
-- posting to commit and a posting waits for an in-flight close before checking.
CREATE OR REPLACE FUNCTION pharmacy_accounting_period_ledger_lock()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ledger_key text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'pharmacy-ledger:' || NEW."organizationId" || ':' || NEW."branchId", 0
    ));
  ELSE
    FOR ledger_key IN
      SELECT DISTINCT k COLLATE "C" FROM (VALUES
        ('pharmacy-ledger:' || OLD."organizationId" || ':' || OLD."branchId"),
        ('pharmacy-ledger:' || NEW."organizationId" || ':' || NEW."branchId")
      ) AS keys(k) ORDER BY 1
    LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended(ledger_key, 0));
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pharmacy_journal_entry_period_open ON finance_journal_entries;
CREATE TRIGGER pharmacy_journal_entry_period_open BEFORE INSERT ON finance_journal_entries
  FOR EACH ROW EXECUTE FUNCTION pharmacy_journal_entry_period_open();
DROP TRIGGER IF EXISTS pharmacy_journal_line_period_open ON finance_journal_lines;
CREATE TRIGGER pharmacy_journal_line_period_open BEFORE INSERT ON finance_journal_lines
  FOR EACH ROW EXECUTE FUNCTION pharmacy_journal_line_period_open();
DROP TRIGGER IF EXISTS pharmacy_accounting_period_ledger_lock ON pharmacy_accounting_periods;
CREATE TRIGGER pharmacy_accounting_period_ledger_lock BEFORE INSERT OR UPDATE ON pharmacy_accounting_periods
  FOR EACH ROW EXECUTE FUNCTION pharmacy_accounting_period_ledger_lock();

COMMIT;
