-- A sale line can span lots with different printed MRPs. Persist its exact
-- weighted gross rather than reconstructing it from one representative price.
ALTER TABLE "pharmacy_sale_lines"
  ADD COLUMN "grossMinor" INTEGER;

UPDATE "pharmacy_sale_lines"
SET "grossMinor" = "unitPriceMinor" * "quantity";

ALTER TABLE "pharmacy_sale_lines"
  ALTER COLUMN "grossMinor" SET NOT NULL;

ALTER TABLE "pharmacy_sale_lines"
  DROP CONSTRAINT "pharmacy_sale_lines_price_check";

ALTER TABLE "pharmacy_sale_lines"
  ADD CONSTRAINT "pharmacy_sale_lines_price_check"
  CHECK (
    "unitPriceMinor" >= 0
    AND "unitPriceMinor" <= "proRataCeilingMinor"
    AND "grossMinor" >= 0
    AND "unitCostMinor" >= 0
    AND "discountMinor" >= 0
    AND "discountMinor" <= "grossMinor"
  );
