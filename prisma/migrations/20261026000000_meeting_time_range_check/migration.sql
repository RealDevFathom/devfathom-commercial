-- The application validates this range for a useful BAD_REQUEST response, but
-- concurrent partial updates can each validate against a stale counterpart.
-- Keep the invariant at the write boundary as the final, atomic defence.
ALTER TABLE "meetings"
ADD CONSTRAINT "meetings_endTime_after_startTime_check"
CHECK ("endTime" > "startTime");
