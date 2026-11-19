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
-- ADD COLUMN IF NOT EXISTS, the check is added only when it is not already there, and the guard
-- is CREATE OR REPLACE with its trigger dropped and re-created. The table keeps its row-level
-- security and policies; no row is read or written here.

ALTER TABLE "pharmacy_branches" ADD COLUMN IF NOT EXISTS "businessDayEndsAtHistory" JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "pharmacy_branches" ADD COLUMN IF NOT EXISTS "businessDayEndsAtRevision" INTEGER NOT NULL DEFAULT 0;

-- The history is a list.
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

-- The history is append-only and moves only days that have not begun. On every insert and every
-- change of the history:
--   * entries already stored can never be changed or removed (the old list is a prefix of the
--     new one);
--   * each new entry is {"from": "YYYY-MM-DD" (a real calendar day), "hour": 0..6, ...}, with
--     "from" on or after the entry before it;
--   * each new entry starts no earlier than the day after the next business day, worked out the
--     way the application does (src/lib/pharmacy/business-day.ts): on the organisation's zone
--     (UTC when it has none Postgres knows), with the hour in force under the stored history.
-- A day that has begun, and every past day with its close and reports, therefore never moves,
-- whoever writes the row. The application reads a history it cannot parse as an error, never as
-- midnight.
CREATE OR REPLACE FUNCTION pharmacy_branch_day_end_history_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_history jsonb := '[]'::jsonb;
  new_history jsonb := NEW."businessDayEndsAtHistory";
  old_count integer;
  new_count integer;
  entry jsonb;
  entry_from date;
  entry_hour numeric;
  previous_from date;
  zone text;
  local_now timestamp;
  calendar_day date;
  hour_in_force integer := 0;
  current_day date;
  earliest date;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."businessDayEndsAtHistory" IS NOT DISTINCT FROM OLD."businessDayEndsAtHistory" THEN
      RETURN NEW;
    END IF;
    old_history := COALESCE(OLD."businessDayEndsAtHistory", '[]'::jsonb);
  END IF;
  IF new_history IS NULL OR jsonb_typeof(new_history) <> 'array' THEN
    RAISE EXCEPTION 'A branch day-end history must be a list of changes' USING ERRCODE = '23514';
  END IF;
  old_count := jsonb_array_length(old_history);
  new_count := jsonb_array_length(new_history);
  IF new_count < old_count THEN
    RAISE EXCEPTION 'A branch day-end history is append-only: a change cannot be removed'
      USING ERRCODE = '23514';
  END IF;
  FOR i IN 0 .. old_count - 1 LOOP
    IF new_history -> i IS DISTINCT FROM old_history -> i THEN
      RAISE EXCEPTION 'A branch day-end history is append-only: a change cannot be rewritten'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF new_count = old_count THEN
    RETURN NEW;
  END IF;

  -- The branch's current business day under the history in force.
  SELECT o."timezone" INTO zone FROM "organizations" o WHERE o."id" = NEW."organizationId";
  IF zone IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names t WHERE t."name" = zone) THEN
    zone := 'UTC';
  END IF;
  local_now := now() AT TIME ZONE zone;
  calendar_day := local_now::date;
  FOR i IN 0 .. old_count - 1 LOOP
    IF (old_history -> i ->> 'from')::date <= calendar_day THEN
      hour_in_force := (old_history -> i ->> 'hour')::integer;
    END IF;
  END LOOP;
  current_day := CASE
    WHEN local_now < calendar_day + make_interval(hours => hour_in_force) THEN calendar_day - 1
    ELSE calendar_day
  END;
  earliest := current_day + 2;
  IF old_count > 0 THEN
    previous_from := (old_history -> (old_count - 1) ->> 'from')::date;
  END IF;

  FOR i IN old_count .. new_count - 1 LOOP
    entry := new_history -> i;
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
       OR jsonb_typeof(entry -> 'from') IS DISTINCT FROM 'string'
       OR (entry ->> 'from') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       OR jsonb_typeof(entry -> 'hour') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'A branch day-end change needs a calendar day and an hour'
        USING ERRCODE = '23514';
    END IF;
    BEGIN
      entry_from := (entry ->> 'from')::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'A branch day-end change needs a real calendar day' USING ERRCODE = '23514';
    END;
    IF to_char(entry_from, 'YYYY-MM-DD') <> (entry ->> 'from') THEN
      RAISE EXCEPTION 'A branch day-end change needs a real calendar day' USING ERRCODE = '23514';
    END IF;
    entry_hour := (entry ->> 'hour')::numeric;
    IF entry_hour <> trunc(entry_hour) OR entry_hour < 0 OR entry_hour > 6 THEN
      RAISE EXCEPTION 'A branch day ends between midnight and 06:00' USING ERRCODE = '23514';
    END IF;
    IF previous_from IS NOT NULL AND entry_from < previous_from THEN
      RAISE EXCEPTION 'A branch day-end history must be in date order' USING ERRCODE = '23514';
    END IF;
    IF entry_from < earliest THEN
      RAISE EXCEPTION 'A branch day-end change applies from % at the earliest', earliest
        USING ERRCODE = '23514';
    END IF;
    previous_from := entry_from;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pharmacy_branch_day_end_history_guard ON "pharmacy_branches";
CREATE TRIGGER pharmacy_branch_day_end_history_guard
  BEFORE INSERT OR UPDATE OF "businessDayEndsAtHistory" ON "pharmacy_branches"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_branch_day_end_history_guard();

COMMIT;
