BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TYPE "PharmacySaleEventKind" ADD VALUE IF NOT EXISTS 'PACK_CHECK';
ALTER TABLE pharmacy_sale_lines ADD COLUMN IF NOT EXISTS "packCheckBlocked" boolean NOT NULL DEFAULT false;

-- Payment and pack verification serialize on the same bill, including a card charge
-- before it leaves the application. The trigger runs with the caller's RLS scope.
CREATE OR REPLACE FUNCTION pharmacy_check_pack_before_payment() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  sale_id text;
BEGIN
  IF TG_TABLE_NAME = 'pharmacy_sales' THEN
    sale_id := NEW.id;
  ELSE
    sale_id := NEW."saleId";
    PERFORM 1 FROM public.pharmacy_sales WHERE id = sale_id
      AND "organizationId" = NEW."organizationId" AND "branchId" = NEW."branchId" FOR UPDATE;
  END IF;
  IF EXISTS (SELECT 1 FROM public.pharmacy_sale_lines WHERE "saleId" = sale_id
    AND "organizationId" = NEW."organizationId" AND "branchId" = NEW."branchId" AND "packCheckBlocked") THEN
    RAISE EXCEPTION 'PACK_CHECK_REQUIRED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pharmacy_check_pack_before_payment() FROM PUBLIC;
CREATE OR REPLACE TRIGGER pharmacy_pack_check_tender BEFORE INSERT ON pharmacy_tenders
  FOR EACH ROW EXECUTE FUNCTION pharmacy_check_pack_before_payment();
CREATE OR REPLACE TRIGGER pharmacy_pack_check_terminal BEFORE INSERT ON pharmacy_card_terminal_attempts
  FOR EACH ROW EXECUTE FUNCTION pharmacy_check_pack_before_payment();
CREATE OR REPLACE TRIGGER pharmacy_pack_check_completion BEFORE UPDATE OF status ON pharmacy_sales
  FOR EACH ROW WHEN (NEW.status = 'COMPLETED' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION pharmacy_check_pack_before_payment();
-- Removed lines stay on their void record; the mismatch event stays on the original bill.
-- An unchecked replacement for that medicine must earn its own successful check.
CREATE OR REPLACE FUNCTION pharmacy_recheck_readded_pack() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.pharmacy_sale_events e
      JOIN public.pharmacy_sale_lines removed ON removed.id = e.payload->>'saleLineId'
        AND removed."organizationId" = NEW."organizationId" AND removed."branchId" = NEW."branchId"
    WHERE e."organizationId" = NEW."organizationId" AND e."branchId" = NEW."branchId"
      AND e."saleId" = NEW."saleId" AND e.kind::text = 'PACK_CHECK' AND e.payload->>'matched' = 'false'
      AND removed."saleId" <> NEW."saleId" AND removed."medicineId" = NEW."medicineId"
      AND removed."packCheckBlocked"
  ) THEN NEW."packCheckBlocked" := true; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pharmacy_recheck_readded_pack() FROM PUBLIC;
CREATE OR REPLACE TRIGGER pharmacy_recheck_readded_pack BEFORE INSERT ON pharmacy_sale_lines
  FOR EACH ROW EXECUTE FUNCTION pharmacy_recheck_readded_pack();
COMMIT;
