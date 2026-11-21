ALTER TYPE "PharmacySaleEventKind" ADD VALUE 'PACK_CHECK';
ALTER TABLE pharmacy_sale_lines ADD COLUMN "packCheckBlocked" boolean NOT NULL DEFAULT false;

-- Payment and pack verification serialize on the same bill, including a card charge
-- before it leaves the application. The trigger runs with the caller's RLS scope.
CREATE FUNCTION pharmacy_check_pack_before_payment() RETURNS trigger
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
CREATE TRIGGER pharmacy_pack_check_tender BEFORE INSERT ON pharmacy_tenders
  FOR EACH ROW EXECUTE FUNCTION pharmacy_check_pack_before_payment();
CREATE TRIGGER pharmacy_pack_check_terminal BEFORE INSERT ON pharmacy_card_terminal_attempts
  FOR EACH ROW EXECUTE FUNCTION pharmacy_check_pack_before_payment();
CREATE TRIGGER pharmacy_pack_check_completion BEFORE UPDATE OF status ON pharmacy_sales
  FOR EACH ROW WHEN (NEW.status = 'COMPLETED' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION pharmacy_check_pack_before_payment();
