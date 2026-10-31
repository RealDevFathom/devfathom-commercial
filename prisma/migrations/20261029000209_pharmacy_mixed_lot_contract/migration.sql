-- Both checks are already valid; SET NOT NULL is a catalog operation.
-- Fail promptly instead of queuing a strong lock behind a long-running checkout.
SET lock_timeout = '5s';
ALTER TABLE "pharmacy_sale_lines" ALTER COLUMN "grossMinor" SET NOT NULL;
ALTER TABLE "pharmacy_sale_lines" DROP CONSTRAINT "pharmacy_sale_lines_gross_minor_not_null";
ALTER TABLE "pharmacy_sale_lines" DROP CONSTRAINT "pharmacy_sale_lines_price_check";
ALTER TABLE "pharmacy_sale_lines" RENAME CONSTRAINT "pharmacy_sale_lines_gross_price_check" TO "pharmacy_sale_lines_price_check";
DROP TRIGGER pharmacy_default_sale_line_gross_minor ON "pharmacy_sale_lines";
DROP FUNCTION pharmacy_default_sale_line_gross_minor();
DROP PROCEDURE pharmacy_backfill_sale_line_gross_minor();
RESET lock_timeout;
