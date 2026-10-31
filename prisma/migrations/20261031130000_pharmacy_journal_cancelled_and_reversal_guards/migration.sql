-- Preserve previously applied migration identities. These additional guards
-- apply equally to existing installations and fresh migration histories.
CREATE FUNCTION prevent_pharmacy_general_journal_cancelled_reopen() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'CANCELLED' AND NEW.status <> 'CANCELLED' THEN
    RAISE EXCEPTION 'cancelled pharmacy journal voucher status cannot change';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "pharmacy_general_journal_cancelled_guard"
BEFORE UPDATE ON "pharmacy_general_journal_documents"
FOR EACH ROW EXECUTE FUNCTION prevent_pharmacy_general_journal_cancelled_reopen();

ALTER TABLE "pharmacy_general_journal_documents"
  ADD CONSTRAINT "pharmacy_general_journal_documents_reversal_date_check"
  CHECK ("reversedAt" IS NULL OR "reversedAt" >= "occurredAt");
