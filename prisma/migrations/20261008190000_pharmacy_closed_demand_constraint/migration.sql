-- CLOSED and closedAt already exist. Recognize closure without inventing recovery.
-- Preserve the existing OPEN and RECOVERED predicates; validate all existing rows.
BEGIN;
ALTER TABLE pharmacy_unfulfilled_demand_events
  DROP CONSTRAINT pharmacy_demand_recovery_check,
  ADD CONSTRAINT pharmacy_demand_recovery_check CHECK (
    (status = 'OPEN' AND "recoveredSaleLineId" IS NULL AND "recoveredAt" IS NULL)
    OR (status = 'RECOVERED' AND "recoveredSaleLineId" IS NOT NULL AND "recoveredAt" IS NOT NULL)
    OR (status = 'CLOSED' AND "closedAt" IS NOT NULL
        AND "recoveredSaleLineId" IS NULL AND "recoveredAt" IS NULL)
  );
COMMIT;
