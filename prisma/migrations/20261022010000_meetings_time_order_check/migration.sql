-- Application validation gives callers a useful 400, but meetings also have
-- direct REST/assistant/import write paths. Keep the invariant at the trust
-- boundary so a missed or racing caller cannot persist an impossible series.
-- Repair legacy zero/backwards ranges deterministically before validating the
-- constraint. PostgreSQL stores these columns at millisecond precision, so a
-- one-millisecond duration is the smallest non-destructive valid range.
UPDATE "meetings"
SET "endTime" = "startTime" + INTERVAL '1 millisecond'
WHERE "endTime" <= "startTime";

ALTER TABLE "meetings"
ADD CONSTRAINT "meetings_time_order_check"
CHECK ("endTime" > "startTime");
