-- DEV-956: an optional whole-bill discount at the pharmacy counter.
--
-- organizations.pharmacyBillDiscountEnabled
--                                     the owner's switch. Off by default, so nothing at
--                                     the counter changes on deploy.
-- pharmacy_sale_lines.billDiscountMinor / billAllocationDiscounts
--                                     a bill discount is never a bill-level amount: it is
--                                     allocated onto the bill's lines (largest remainder,
--                                     exact to the paisa). A line's share is included in
--                                     its discountMinor, like the prepaid tier share, and
--                                     each lot's part of it is kept in its own snapshot so
--                                     the append-only allocation rows are never changed.
-- PharmacySaleEventKind.BILL_DISCOUNT the sale event that records who gave the discount,
--                                     who approved it and how it was shared.
--
-- The database refuses a share that does not add up, names a lot the line did not sell,
-- takes a lot below its cost, or changes once the bill has a payment or is no longer open.
-- The prepaid tier's lot floor now counts the bill share too.
--
-- Additive and idempotent: nothing is changed or backfilled.
BEGIN;

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "pharmacyBillDiscountEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TYPE "PharmacySaleEventKind" ADD VALUE IF NOT EXISTS 'BILL_DISCOUNT';

ALTER TABLE "pharmacy_sale_lines"
  ADD COLUMN IF NOT EXISTS "billDiscountMinor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "billAllocationDiscounts" JSONB;

ALTER TABLE "pharmacy_sale_lines" DROP CONSTRAINT IF EXISTS "pharmacy_bill_discount_line_check";
ALTER TABLE "pharmacy_sale_lines" ADD CONSTRAINT "pharmacy_bill_discount_line_check"
  CHECK ("billDiscountMinor" >= 0
    AND "billDiscountMinor"::bigint + "tierDiscountMinor"::bigint <= "discountMinor"::bigint
    AND ("billDiscountMinor" = 0) = ("billAllocationDiscounts" IS NULL));

-- Checked at commit: the lot snapshot must add up to the line's share, name only this line's
-- own priced allocations, and leave every lot that takes a share at or above its cost.
CREATE OR REPLACE FUNCTION pharmacy_bill_discount_check_line_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE line pharmacy_sale_lines%ROWTYPE; total BIGINT;
BEGIN
  SELECT * INTO line FROM pharmacy_sale_lines WHERE id = NEW.id AND "organizationId" = NEW."organizationId";
  IF NOT FOUND OR line."billDiscountMinor" = 0 THEN RETURN NULL; END IF;
  IF line."billAllocationDiscounts" IS NULL OR jsonb_typeof(line."billAllocationDiscounts") <> 'object' THEN
    RAISE EXCEPTION 'Bill discount requires allocation evidence';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(line."billAllocationDiscounts") d WHERE jsonb_typeof(d.value) <> 'number') THEN
    RAISE EXCEPTION 'Bill discount requires allocation evidence';
  END IF;
  SELECT SUM(value::bigint) INTO total FROM jsonb_each_text(line."billAllocationDiscounts");
  IF total IS DISTINCT FROM line."billDiscountMinor"::bigint OR EXISTS (
    SELECT 1 FROM jsonb_each_text(line."billAllocationDiscounts") d
    LEFT JOIN pharmacy_sale_line_allocations a
      ON a.id = d.key AND a."organizationId" = line."organizationId" AND a."saleLineId" = line.id
    LEFT JOIN pharmacy_inventory_lots l ON l.id = a."inventoryLotId" AND l."organizationId" = a."organizationId"
    WHERE a.id IS NULL OR l.id IS NULL OR d.value::bigint < 0
      OR a."grossMinor" IS NULL OR a."discountMinor" IS NULL
      OR (d.value::bigint > 0 AND
        a."grossMinor"::bigint - a."discountMinor"::bigint - d.value::bigint
          < l."unitCostMinor"::bigint * a."canonicalUnits"::bigint)
  ) THEN RAISE EXCEPTION 'Bill discount exceeds allocation price floor'; END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS pharmacy_bill_discount_line_evidence ON pharmacy_sale_lines;
CREATE CONSTRAINT TRIGGER pharmacy_bill_discount_line_evidence AFTER INSERT OR UPDATE ON pharmacy_sale_lines
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW."billDiscountMinor" > 0)
EXECUTE FUNCTION pharmacy_bill_discount_check_line_evidence();

-- A bill discount is given or changed only on an open bill that has taken no payment of any
-- kind, and never on a line the prepaid tier has already priced.
CREATE OR REPLACE FUNCTION pharmacy_bill_discount_freeze_line() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."billDiscountMinor", NEW."billAllocationDiscounts")
     IS DISTINCT FROM (OLD."billDiscountMinor", OLD."billAllocationDiscounts") THEN
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
DROP TRIGGER IF EXISTS pharmacy_bill_discount_freeze_line ON pharmacy_sale_lines;
CREATE TRIGGER pharmacy_bill_discount_freeze_line BEFORE UPDATE ON pharmacy_sale_lines
FOR EACH ROW EXECUTE FUNCTION pharmacy_bill_discount_freeze_line();

-- The prepaid tier's lot floor now counts the lot's bill share, so a tier share on top of a
-- bill discount still leaves every lot at or above its cost.
CREATE OR REPLACE FUNCTION pharmacy_prepaid_check_line_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line pharmacy_sale_lines%ROWTYPE; total BIGINT;
BEGIN
 SELECT * INTO line FROM pharmacy_sale_lines WHERE id=NEW.id AND "organizationId"=NEW."organizationId";
 IF NOT FOUND OR line."tierDiscountMinor" = 0 THEN RETURN NULL; END IF;
 IF line."tierName" IS NULL OR line."tierAllocationDiscounts" IS NULL OR jsonb_typeof(line."tierAllocationDiscounts") <> 'object' THEN
   RAISE EXCEPTION 'Prepaid discount requires allocation evidence';
 END IF;
 SELECT SUM(value::bigint) INTO total FROM jsonb_each_text(line."tierAllocationDiscounts");
 IF total IS DISTINCT FROM line."tierDiscountMinor"::bigint OR EXISTS (
   SELECT 1 FROM jsonb_each_text(line."tierAllocationDiscounts") d
   LEFT JOIN pharmacy_sale_line_allocations a ON a.id=d.key AND a."organizationId"=line."organizationId" AND a."saleLineId"=line.id
   LEFT JOIN pharmacy_inventory_lots l ON l.id=a."inventoryLotId" AND l."organizationId"=a."organizationId"
   WHERE a.id IS NULL OR l.id IS NULL OR d.value::bigint < 0 OR a."grossMinor" IS NULL OR a."discountMinor" IS NULL
     -- Only an allocation that takes a tier share must stay at or above its cost. An allocation
     -- an earlier, line-level discount already left below cost takes a zero share and is not
     -- this discount's doing. DEV-956: the lot's bill-discount share counts as taken.
     OR (d.value::bigint > 0 AND
       a."grossMinor"::bigint-a."discountMinor"::bigint
         -COALESCE((line."billAllocationDiscounts" ->> a.id)::bigint, 0)
         -d.value::bigint < l."unitCostMinor"::bigint*a."canonicalUnits"::bigint)
 ) THEN RAISE EXCEPTION 'Prepaid discount exceeds allocation price floor'; END IF;
 RETURN NULL;
END $$;

COMMIT;
