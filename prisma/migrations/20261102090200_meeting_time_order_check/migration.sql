-- DEV-249 / #451: a meeting must end strictly after it starts.
--
-- Nothing enforced this before: the tRPC router, the REST route, the
-- assistant's update tool and the forms all accepted an end at or before the
-- start. Every one of them now refuses such a range through
-- `src/lib/meetings/time-order.ts`; this CHECK is the floor under them, so a
-- writer added later cannot bring the defect back.
--
-- WHY REPAIR RATHER THAN `NOT VALID`. Rows written before this change may break
-- the rule, and the migration must not fail on them. `NOT VALID` would skip the
-- scan of existing rows, but PostgreSQL still checks a NOT VALID constraint
-- against the NEW version of every row an UPDATE touches. A bad row would then
-- refuse every UPDATE, and `materializeMeetingOccurrences` writes
-- `meetings."materializedThrough"` on nearly every call (create, update, the
-- occurrence list, each join). Those meetings would start returning 500s on
-- read paths, and nobody could even rename one until its times were fixed by
-- hand. Repairing the rows first and then adding a VALIDATED constraint leaves
-- no row in that state.
--
-- THE REPAIR. Only "endTime" changes. It becomes "startTime" + 30 minutes.
--   - "startTime" stays put. It is the time attendees were told, and for a
--     recurring series it is the anchor every occurrence slot
--     (`seriesSlotStart`) is computed from. Moving it would make the
--     materialiser cancel and recreate the series' future occurrences.
--   - 30 minutes is a placeholder, not a recovered value. The real duration
--     cannot be known because the stored end IS the error. A short default
--     slot is the least surprising guess, and the owner can edit it.
--   - The materialiser clamps a backwards duration to zero, so these series
--     already have zero-length FUTURE occurrences. Those rows are rebuilt from
--     the same repaired duration. Only untouched slots are rebuilt: SCHEDULED,
--     still ahead, never rescheduled (`scheduledStart = seriesSlotStart`). Past
--     occurrences are history and keep the times they were held under.
--   - The join window moves by the same amount, so whatever lag the row was
--     created with is kept.
-- Only aggregate counts are reported (no meeting ids, titles or tenants), the
-- same way the MEET-01 migration reports.
--
-- One explicit transaction: the platform scope below is transaction-local, so
-- the repair and the constraint must run inside the same transaction as the
-- set_config that grants it.
--
-- Idempotent: a second run repairs nothing (no meeting can still end at or
-- before its start, and occurrences are rebuilt only for meetings repaired in
-- the same run), and the constraint is added only when absent.

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Refuse to run blind.
-- ---------------------------------------------------------------------------
-- `meetings` and `meeting_occurrences` both FORCE row level security, and FORCE
-- applies to the table owner too. Without a platform scope, the repair below
-- would see no rows under a non-bypassing role, and the constraint would then
-- fail on the rows it missed. Take the scope for this transaction and check
-- that it applied, as MEET-01 does.
SELECT set_config('app.is_platform_admin', 'true', true);

DO $$
BEGIN
  IF row_security_active('meetings')
     AND current_setting('app.is_platform_admin', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'DEV-249: row level security is active for role % on "meetings" and no platform scope is set. The repair would silently see no rows; aborting.',
      current_user;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Repair existing rows.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  repaired_meetings bigint;
  rebuilt_occurrences bigint;
BEGIN
  WITH repaired AS (
    UPDATE "meetings"
       SET "endTime" = "startTime" + interval '30 minutes',
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "endTime" <= "startTime"
    RETURNING "id"
  ),
  rebuilt AS (
    UPDATE "meeting_occurrences" AS occurrence
       SET "scheduledEnd" = occurrence."scheduledStart" + interval '30 minutes',
           "joinClosesAt" = occurrence."joinClosesAt"
             + ((occurrence."scheduledStart" + interval '30 minutes') - occurrence."scheduledEnd"),
           "updatedAt" = CURRENT_TIMESTAMP
      FROM repaired
     WHERE occurrence."meetingId" = repaired."id"
       AND occurrence."status" = 'SCHEDULED'
       AND occurrence."scheduledStart" = occurrence."seriesSlotStart"
       AND occurrence."scheduledStart" > CURRENT_TIMESTAMP
       AND occurrence."scheduledEnd" <= occurrence."scheduledStart"
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM repaired), (SELECT count(*) FROM rebuilt)
    INTO repaired_meetings, rebuilt_occurrences;

  RAISE NOTICE
    'DEV-249: % meeting(s) ended at or before their start; their end was set to start + 30 minutes, and % future occurrence(s) were rebuilt to match.',
    repaired_meetings, rebuilt_occurrences;
END $$;

-- ---------------------------------------------------------------------------
-- 2. The rule itself.
-- ---------------------------------------------------------------------------
-- Validated as it is added. That scan reads the heap directly, not through row
-- level security, so a row the repair could not see fails the migration here
-- instead of slipping through.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = '"meetings"'::regclass AND conname = 'meetings_time_order_check'
  ) THEN
    ALTER TABLE "meetings"
      ADD CONSTRAINT "meetings_time_order_check" CHECK ("endTime" > "startTime");
  END IF;
END
$$;

COMMIT;
