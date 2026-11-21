BEGIN;
ALTER TABLE pharmacy_sale_lines ADD COLUMN IF NOT EXISTS "lineAllocationDiscounts" jsonb;
-- Keep the lot prices at the time of dispensing immutable. Verify the separate
-- adjustment against those snapshots, including any later prepaid tier share.
CREATE OR REPLACE FUNCTION pharmacy_verify_line_discount_shares() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  share record;
  total bigint := 0;
BEGIN
  IF OLD."lineAllocationDiscounts" IS NOT NULL AND OLD."lineAllocationDiscounts" IS DISTINCT FROM NEW."lineAllocationDiscounts" THEN
    RAISE EXCEPTION 'Recorded line discount shares are immutable';
  END IF;
  IF NEW."lineAllocationDiscounts" IS NULL THEN RETURN NEW; END IF;
  IF NEW."approvedByUserId" IS NULL OR NEW."approvalPolicy" IS NULL OR NEW."billDiscountMinor" <> 0 THEN
    RAISE EXCEPTION 'Missing line discount approval or overlapping bill discount';
  END IF;
  FOR share IN SELECT * FROM jsonb_each_text(NEW."lineAllocationDiscounts") LOOP
    IF share.value::bigint < 0 OR NOT EXISTS (
      SELECT 1 FROM public.pharmacy_sale_line_allocations a JOIN public.pharmacy_inventory_lots l
        ON l.id=a."inventoryLotId" AND l."organizationId"=a."organizationId"
      WHERE a.id=share.key AND a."saleLineId"=NEW.id AND a."organizationId"=NEW."organizationId"
        AND a."discountMinor"=0 AND a."grossMinor" - share.value::bigint -
          COALESCE((NEW."tierAllocationDiscounts" ->> a.id)::bigint,0) >= l."unitCostMinor"::bigint*a."canonicalUnits"
    ) THEN RAISE EXCEPTION 'Invalid line discount allocation'; END IF;
    total := total + share.value::bigint;
  END LOOP;
  IF total <= 0 OR total <> NEW."discountMinor" - NEW."tierDiscountMinor" THEN
    RAISE EXCEPTION 'Line discount shares must match the line discount';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pharmacy_verify_line_discount_shares() FROM PUBLIC;
CREATE OR REPLACE TRIGGER pharmacy_line_discount_evidence BEFORE UPDATE ON pharmacy_sale_lines
  FOR EACH ROW EXECUTE FUNCTION pharmacy_verify_line_discount_shares();
COMMIT;
