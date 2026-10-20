-- H1-05 / PROP-07 — two same-tenant integrity gaps in the booking range of
-- `20261021102000_hospitality_function_spaces`, found by the independent review
-- of that migration (hotel port plan §4, reserved slot 20261021104000). Neither
-- is reachable through the routers, which never write `bufferedRange` and
-- serialise every space write behind the property lock; both are reachable with
-- raw tenant SQL, and invariant 25 ("one function per slot, buffers included")
-- is the database's to hold whoever the writer is. A migration is never edited
-- after it ships, so this one re-creates the trigger and the function in place.
--
-- (a) `bufferedRange` could be written around the trigger. The BEFORE trigger
--     fired on `UPDATE OF "startsAt", "endsAt", "spaceId", "organizationId"`
--     and not on `"bufferedRange"`, so `UPDATE … SET "bufferedRange" = 'empty'`
--     on an existing booking left a range the exclusion constraint could no
--     longer collide with, and a booking over the same hour was then admitted.
--     The trigger now fires on EVERY update: the range is always recomputed from
--     the booking's own start and end plus the space's buffers, so a direct
--     write to the column is overwritten rather than trusted.
--
-- (b) The trigger read the space's buffers without a lock. Two transactions
--     could interleave — one widening a space's setup time, one inserting a
--     hold on that space — so that the hold's range was computed from the old
--     buffers and the widening's re-range (the AFTER UPDATE trigger on the
--     space) never saw the not-yet-committed hold: a committed booking with a
--     stale range. The read now takes `FOR SHARE` on the space row. An UPDATE
--     of a non-key column such as `"setupMinutes"` takes FOR NO KEY UPDATE,
--     which FOR SHARE conflicts with (FOR KEY SHARE would not), so whichever
--     transaction is second waits for the first to commit: a booking written
--     after a widening reads the new buffers, and a widening written after a
--     booking re-ranges that booking. Concurrent bookings of one space take
--     FOR SHARE together and are left to the exclusion constraint, as before.
--     Row locks need UPDATE privilege on the table, which the runtime role
--     holds; row-level security applies to the locked read as it did to the
--     plain one, so a space the connection cannot see still raises.
--
-- Known, unchanged: a single space UPDATE that widens one buffer and narrows the
-- other re-ranges that space's bookings one row at a time with the exclusion
-- constraint checked per row, so it can be refused when a later row would have
-- made room. A deferrable exclusion constraint would settle it; left for the
-- banquet lane, which owns the diary.

CREATE OR REPLACE FUNCTION "hotel_space_booking_buffered_range"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  setup_minutes integer;
  teardown_minutes integer;
BEGIN
  -- FOR SHARE, not FOR KEY SHARE: it has to conflict with the FOR NO KEY UPDATE
  -- a buffer change takes, so a booking and a re-buffer of the same space never
  -- commit on different views of the buffers (gap (b) above).
  SELECT "setupMinutes", "teardownMinutes"
    INTO setup_minutes, teardown_minutes
    FROM "hotel_function_spaces"
   WHERE "organizationId" = NEW."organizationId"
     AND "id" = NEW."spaceId"
     FOR SHARE;

  -- Unreachable through the foreign key for a tenant connection; reachable for a
  -- connection with no tenant context, where row-level security hides the space.
  -- Failing here is correct: a booking whose buffers cannot be read must not exist.
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'function space % is not visible to this connection; a space booking cannot be written without its buffers',
      NEW."spaceId";
  END IF;

  NEW."bufferedRange" := tstzrange(
    NEW."startsAt" - make_interval(mins => setup_minutes),
    NEW."endsAt" + make_interval(mins => teardown_minutes),
    '[)'
  );
  RETURN NEW;
END;
$$;

-- Every UPDATE, not a column list: a write to "bufferedRange" itself must run
-- the recomputation that overwrites it (gap (a) above).
DROP TRIGGER IF EXISTS "hotel_space_bookings_buffered_range" ON "hotel_space_bookings";
CREATE TRIGGER "hotel_space_bookings_buffered_range"
  BEFORE INSERT OR UPDATE
  ON "hotel_space_bookings"
  FOR EACH ROW
  EXECUTE FUNCTION "hotel_space_booking_buffered_range"();
