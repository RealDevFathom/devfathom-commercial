BEGIN;
SET LOCAL lock_timeout = '5s';
-- Historical entries remain readable. A new sale can no longer use the owner's
-- DEV-911 marker, including when the branch does not require an independent witness.
CREATE OR REPLACE FUNCTION pharmacy_refuse_unapproved_controlled_sale() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A pharmacist must approve this controlled medicine.' USING ERRCODE='23514';
END $$;
DROP TRIGGER IF EXISTS pharmacy_refuse_unapproved_controlled_sale ON pharmacy_controlled_register_entries;
CREATE TRIGGER pharmacy_refuse_unapproved_controlled_sale BEFORE INSERT ON pharmacy_controlled_register_entries
  FOR EACH ROW WHEN (NEW."entryKind"='SALE' AND NEW."signatureRef" LIKE 'pharmacist-check-off:%')
  EXECUTE FUNCTION pharmacy_refuse_unapproved_controlled_sale();
COMMIT;
