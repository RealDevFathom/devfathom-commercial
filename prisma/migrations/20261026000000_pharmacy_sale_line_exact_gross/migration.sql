ALTER TABLE "pharmacy_sale_lines"
ADD COLUMN "grossMinor" INTEGER NOT NULL DEFAULT 0;

UPDATE "pharmacy_sale_lines"
SET "grossMinor" = "unitPriceMinor" * "quantity";
