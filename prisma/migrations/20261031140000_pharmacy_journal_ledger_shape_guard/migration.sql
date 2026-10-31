-- A pharmacy journal voucher posts exactly one debit and one credit line, and
-- its reversal exactly negates them. The document trigger checks that shape
-- only when the document row changes, and the ledger is append-only but still
-- accepts new balanced lines. Reject any line appended to a voucher entry
-- once its two legs exist or once a voucher document links it, so posted
-- totals cannot drift away from the voucher amount through direct SQL.
CREATE FUNCTION prevent_pharmacy_journal_voucher_line_append() RETURNS trigger AS $$
DECLARE
  kind text;
BEGIN
  SELECT entry."sourceKind"::text INTO kind FROM "finance_journal_entries" entry
  WHERE entry."organizationId" = NEW."organizationId" AND entry.id = NEW."entryId";
  IF kind IS DISTINCT FROM 'PHARMACY_JOURNAL_VOUCHER' THEN
    RETURN NEW;
  END IF;

  -- Serialize concurrent line writers for one entry so each sees the others'
  -- committed legs before counting.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."organizationId" || ':' || NEW."entryId" || ':pharmacy-jv-lines', 0));

  IF (SELECT COUNT(*) FROM "finance_journal_lines" line
      WHERE line."organizationId" = NEW."organizationId" AND line."entryId" = NEW."entryId") >= 2
    OR EXISTS (SELECT 1 FROM "pharmacy_general_journal_documents" document
      WHERE document."organizationId" = NEW."organizationId"
        AND (document."journalEntryId" = NEW."entryId" OR document."reversalEntryId" = NEW."entryId"))
  THEN
    RAISE EXCEPTION 'pharmacy journal voucher postings have a fixed two-line shape' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "finance_journal_lines_pharmacy_voucher_shape"
BEFORE INSERT ON "finance_journal_lines"
FOR EACH ROW EXECUTE FUNCTION prevent_pharmacy_journal_voucher_line_append();
