BEGIN;

-- DEV-958A (phase 1 of DEV-958): a "day ends at" hour for each pharmacy branch, kept as a dated
-- history. A shop open past midnight keeps its late trade on one business day and one drawer:
-- with an hour of 5, a sale at 00:30 books on the day before. Until now the business day ended at
-- midnight in the organisation's zone; an empty history is midnight on every day, so every
-- existing branch keeps exactly that day.
--
-- "businessDayEndsAtHistory" is a JSON array of changes, appended by the application and never
-- rewritten: {"from": "YYYY-MM-DD", "hour": 0..6, "actorId": ..., "at": ...}. A change applies
-- from business day "from" (the day after the next business day when it was made), so business
-- day D always starts on calendar date D at the hour in force on D. Past days keep the boundary
-- their close counted; the audit log records each change with who made it and when.
--
-- Additive: two columns with defaults, so no existing row changes meaning, and nothing already
-- recorded (business dates stamped on drawers, sales, tenders, closes) is rewritten. Idempotent:
-- ADD COLUMN IF NOT EXISTS, and the check is added only when it is not already there. The table
-- keeps its row-level security and policies; no row is read or written here.

ALTER TABLE "pharmacy_branches" ADD COLUMN IF NOT EXISTS "businessDayEndsAtHistory" JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "pharmacy_branches" ADD COLUMN IF NOT EXISTS "businessDayEndsAtRevision" INTEGER NOT NULL DEFAULT 0;

-- The history is a list; its entries are checked by the application, which ignores any that are
-- not a valid change (a day and an hour from midnight to 06:00).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pharmacy_branches_business_day_ends_at_history_check'
       AND conrelid = '"pharmacy_branches"'::regclass
  ) THEN
    ALTER TABLE "pharmacy_branches"
      ADD CONSTRAINT "pharmacy_branches_business_day_ends_at_history_check"
      CHECK (jsonb_typeof("businessDayEndsAtHistory") = 'array');
  END IF;
END $$;

COMMIT;
