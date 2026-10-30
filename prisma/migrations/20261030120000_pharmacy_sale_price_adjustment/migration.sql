-- An integer unit price can round up a weighted mixed-lot price. This bounded
-- remainder is pricing, not a customer discount; keep the approval check intact.
ALTER TABLE "pharmacy_sale_lines"
  ADD COLUMN "priceAdjustmentMinor" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "pharmacy_sale_lines_price_adjustment_check" CHECK (
    "priceAdjustmentMinor" >= 0 AND "priceAdjustmentMinor" < "quantity"
    AND "discountMinor"::bigint + "priceAdjustmentMinor"
      <= "unitPriceMinor"::bigint * "quantity"
  );

-- Preserve the actual canonical-unit sale price for lot-specific returns and
-- revenue. NULL keeps historical sales on their original line pricing policy.
ALTER TABLE "pharmacy_sale_line_allocations"
  ADD COLUMN "unitPriceMinor" INTEGER,
  ADD CONSTRAINT "pharmacy_sale_alloc_price_check" CHECK ("unitPriceMinor" >= 0);
