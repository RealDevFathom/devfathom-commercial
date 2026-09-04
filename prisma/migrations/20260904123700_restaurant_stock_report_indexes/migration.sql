-- WHA-1295: keep the bounded Restaurant wastage and stock-movement reports on
-- index-backed ledger scans without changing the append-only movement model.
CREATE INDEX "restaurant_stock_movements_location_occurred_item_idx"
ON "restaurant_stock_movements"("locationId", "occurredAt", "stockItemId");

CREATE INDEX "restaurant_stock_movements_reason_occurred_location_idx"
ON "restaurant_stock_movements"("reason", "occurredAt", "locationId");
