SET lock_timeout = '5s';

ALTER TABLE "pharmacy_sale_lines"
  VALIDATE CONSTRAINT "pharmacy_sale_lines_prescription_line_fkey";
