-- Updates already enforce canonical posting/reversal links. Keep inserts on
-- the draft path and preserve posted source evidence against direct deletion.
CREATE FUNCTION prevent_pharmacy_general_journal_lifecycle_bypass() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW."journalEntryId" IS NOT NULL OR
      NEW."reversalEntryId" IS NOT NULL OR NEW."postedAt" IS NOT NULL OR
      NEW."cancelledAt" IS NOT NULL OR NEW."reversedAt" IS NOT NULL OR
      NEW."postKey" IS NOT NULL OR NEW."postPayloadHash" IS NOT NULL OR
      NEW."reverseKey" IS NOT NULL OR NEW."reversePayloadHash" IS NOT NULL THEN
      RAISE EXCEPTION 'pharmacy journal vouchers must be inserted as unposted drafts';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('POSTED', 'REVERSED') THEN
    RAISE EXCEPTION 'posted pharmacy journal vouchers cannot be deleted';
  END IF;
  RETURN OLD;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "pharmacy_general_journal_lifecycle_guard"
BEFORE INSERT OR DELETE ON "pharmacy_general_journal_documents"
FOR EACH ROW EXECUTE FUNCTION prevent_pharmacy_general_journal_lifecycle_bypass();
