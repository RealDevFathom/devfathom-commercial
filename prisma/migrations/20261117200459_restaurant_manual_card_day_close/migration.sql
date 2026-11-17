BEGIN;

-- Existing append-only tenant tables retain their forced RLS policies. Historical
-- closes have no breakdown: do not invent or backfill an immutable snapshot.
ALTER TABLE restaurant_daily_closes
  ADD COLUMN IF NOT EXISTS "manualCardSummary" JSONB;
ALTER TABLE restaurant_refunds
  ADD COLUMN IF NOT EXISTS "cardMachineRefundReference" VARCHAR(120);

COMMIT;
