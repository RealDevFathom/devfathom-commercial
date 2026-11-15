BEGIN;

-- Solo-pharmacy rule for write-off custody (DEV-628).
-- A custody record keeps its independent-witness rule. The one exception is a
-- solo owner or sole pharmacist who witnessed their own write-off with a fresh
-- PIN: the application verifies that PIN, sets the transaction-local marker
-- below to the actor and audits the self-witness in the same transaction.
-- Every other row still needs a second person.
DO $$
DECLARE legacy record;
BEGIN
  FOR legacy IN
    SELECT conname FROM pg_catalog.pg_constraint
    WHERE conrelid = 'pharmacy_custody_records'::regclass
      AND contype = 'c'
      AND pg_catalog.pg_get_constraintdef(oid) ~ '"actorId" <> "witnessId"'
  LOOP
    EXECUTE format('ALTER TABLE "pharmacy_custody_records" DROP CONSTRAINT %I', legacy.conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'pharmacy_custody_records_evidence'
      AND conrelid = 'pharmacy_custody_records'::regclass
  ) THEN
    ALTER TABLE "pharmacy_custody_records"
      ADD CONSTRAINT "pharmacy_custody_records_evidence"
      CHECK (length(btrim("reason")) > 0 AND length(btrim("evidenceRef")) > 0);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.pharmacy_custody_independent_witness() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."actorId" = NEW."witnessId"
    AND COALESCE(current_setting('app.pharmacy_write_off_solo_witness_user_id', true), '') <> NEW."actorId"
  THEN
    RAISE EXCEPTION 'pharmacy custody record needs an independent witness'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pharmacy_custody_records_independent_witness ON "pharmacy_custody_records";
CREATE TRIGGER pharmacy_custody_records_independent_witness
  BEFORE INSERT ON "pharmacy_custody_records"
  FOR EACH ROW EXECUTE FUNCTION public.pharmacy_custody_independent_witness();

COMMIT;
