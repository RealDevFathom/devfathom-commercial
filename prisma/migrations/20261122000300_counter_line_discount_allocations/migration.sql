BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE pharmacy_sale_lines ADD COLUMN IF NOT EXISTS "lineAllocationDiscounts" jsonb;
-- Keep the lot prices at the time of dispensing immutable. Verify the separate
-- adjustment against those snapshots, including any later prepaid tier share.
CREATE OR REPLACE FUNCTION pharmacy_verify_line_discount_shares() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  share record;
  total bigint := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."lineAllocationDiscounts" IS NOT NULL THEN
      RAISE EXCEPTION 'Line discount requires existing sale allocations';
    END IF;
    RETURN NEW;
  END IF;
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
CREATE OR REPLACE TRIGGER pharmacy_line_discount_evidence BEFORE INSERT OR UPDATE ON pharmacy_sale_lines
  FOR EACH ROW EXECUTE FUNCTION pharmacy_verify_line_discount_shares();

-- Apply the same parent bill and tender checks to either allocation adjustment.
CREATE OR REPLACE FUNCTION pharmacy_bill_discount_freeze_line() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."billDiscountMinor", NEW."billAllocationDiscounts", NEW."lineAllocationDiscounts")
     IS DISTINCT FROM (OLD."billDiscountMinor", OLD."billAllocationDiscounts", OLD."lineAllocationDiscounts") THEN
    IF OLD."tierDiscountMinor" <> 0 OR NEW."tierDiscountMinor" <> 0
       OR NEW."grossMinor" IS DISTINCT FROM OLD."grossMinor"
       OR NOT EXISTS (
         SELECT 1 FROM pharmacy_sales s
          WHERE s.id = NEW."saleId" AND s."organizationId" = NEW."organizationId"
            AND s."branchId" = NEW."branchId" AND s.status = 'OPEN')
       OR EXISTS (
         SELECT 1 FROM pharmacy_tenders t
          WHERE t."saleId" = NEW."saleId" AND t."organizationId" = NEW."organizationId")
    THEN
      RAISE EXCEPTION 'Bill discount evidence is immutable once the bill is paid or closed';
    END IF;
  END IF;
  RETURN NEW;
END $$;
COMMIT;
