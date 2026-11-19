BEGIN;

-- DEV-958A (phase 1 of DEV-958): a "day ends at" hour for each pharmacy branch. A shop open past
-- midnight keeps its late trade on one business day and one drawer: with an hour of 5, a sale at
-- 00:30 on the shop's clock books on the day before. Until now the business day ended at midnight
-- in the organisation's zone; 0 (midnight) is the default, so every existing branch keeps exactly
-- that day.
--
-- Additive: two columns with defaults, so no existing row changes meaning, and nothing already
-- recorded (business dates stamped on drawers, sales, tenders, closes) is rewritten. The hour is
-- read only when a new instant is placed on a business day. Idempotent: ADD COLUMN IF NOT EXISTS,
-- and the check is added only when it is not already there. The table keeps its row-level
-- security and policies; no row is read or written here.

ALTER TABLE "pharmacy_branches" ADD COLUMN IF NOT EXISTS "businessDayEndsAtHour" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "pharmacy_branches" ADD COLUMN IF NOT EXISTS "businessDayEndsAtRevision" INTEGER NOT NULL DEFAULT 0;

-- Midnight to 06:00: a later hour would put a morning's trade on the day before.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pharmacy_branches_business_day_ends_at_hour_check'
       AND conrelid = '"pharmacy_branches"'::regclass
  ) THEN
    ALTER TABLE "pharmacy_branches"
      ADD CONSTRAINT "pharmacy_branches_business_day_ends_at_hour_check"
      CHECK ("businessDayEndsAtHour" BETWEEN 0 AND 6);
  END IF;
END $$;

COMMIT;
