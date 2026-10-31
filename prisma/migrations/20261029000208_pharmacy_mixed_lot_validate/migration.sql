-- Validate in a separate transaction under SHARE UPDATE EXCLUSIVE, allowing
-- checkout writes. Do not combine with the stronger expand/contract DDL locks.
ALTER TABLE "pharmacy_sale_lines"
  VALIDATE CONSTRAINT "pharmacy_sale_lines_gross_minor_not_null",
  VALIDATE CONSTRAINT "pharmacy_sale_lines_gross_price_check";
