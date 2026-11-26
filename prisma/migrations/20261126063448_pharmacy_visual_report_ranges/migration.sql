BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE INDEX pharmacy_visual_sale_dates_idx
  ON pharmacy_sales ("organizationId", "branchId", status, "businessDate");

CREATE INDEX pharmacy_visual_return_dates_idx
  ON pharmacy_sale_returns ("organizationId", "branchId", "createdAt");

CREATE INDEX pharmacy_visual_return_lines_idx
  ON pharmacy_sale_return_lines ("organizationId", "branchId", "returnId");

COMMIT;
