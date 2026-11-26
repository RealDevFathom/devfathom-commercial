BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS pharmacy_dashboard_sale_days
    ON pharmacy_sales ("organizationId", "branchId", "businessDate")
    WHERE status = 'COMPLETED';
CREATE INDEX IF NOT EXISTS pharmacy_dashboard_stock_days
    ON pharmacy_stock_movements ("organizationId", "branchId", "occurredAt")
    WHERE disposition = 'AVAILABLE';

COMMIT;
