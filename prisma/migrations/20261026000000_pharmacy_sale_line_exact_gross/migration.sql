BEGIN;

ALTER TABLE "pharmacy_sale_lines"
ADD COLUMN "grossMinor" INTEGER NOT NULL DEFAULT 0;

UPDATE "pharmacy_sale_lines"
SET "grossMinor" = "unitPriceMinor" * "quantity";

ALTER TABLE "pharmacy_sale_lines"
DROP CONSTRAINT "pharmacy_sale_lines_price_check",
ADD CONSTRAINT "pharmacy_sale_lines_price_check"
  CHECK ("unitPriceMinor" >= 0 AND "unitPriceMinor" <= "proRataCeilingMinor"
    AND "unitCostMinor" >= 0 AND "grossMinor" >= 0 AND "discountMinor" >= 0
    AND "grossMinor" >= "unitPriceMinor"::bigint * "quantity"
    AND "grossMinor" < ("unitPriceMinor"::bigint + 1) * "quantity"
    AND "discountMinor" <= "grossMinor");

COMMIT;
