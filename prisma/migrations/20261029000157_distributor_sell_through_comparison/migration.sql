ALTER TABLE "pharmacy_quote_lines"
  ADD COLUMN "forecastSellThroughPacks" INTEGER;

ALTER TABLE "pharmacy_purchase_order_lines"
  ADD COLUMN "forecastSellThroughPacks" INTEGER,
  ADD COLUMN "minimumExpiryDays" INTEGER,
  ADD COLUMN "leadTimeDays" INTEGER;

ALTER TABLE "pharmacy_quote_lines"
  ADD CONSTRAINT "pharmacy_quote_lines_forecast_sell_through_positive"
  CHECK ("forecastSellThroughPacks" > 0);

ALTER TABLE "pharmacy_purchase_order_lines"
  ADD CONSTRAINT "pharmacy_po_lines_forecast_sell_through_positive"
  CHECK ("forecastSellThroughPacks" IS NULL OR "forecastSellThroughPacks" > 0);
