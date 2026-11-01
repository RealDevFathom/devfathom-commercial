-- Support active-order readiness counts at the branch and business-date grain.
CREATE INDEX "restaurant_orders_branchId_businessDate_status_idx"
ON "restaurant_orders" ("branchId", "businessDate", "status");
