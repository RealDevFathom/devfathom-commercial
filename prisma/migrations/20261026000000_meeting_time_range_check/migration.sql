-- Install the guard without scanning legacy rows first. NOT VALID still
-- protects every new or updated row while allowing the existing defect to be
-- remediated before validation.
ALTER TABLE "meetings"
ADD CONSTRAINT "meetings_endTime_after_startTime_check"
CHECK ("endTime" > "startTime") NOT VALID;

-- Preserve each affected meeting's start and use the smallest duration the
-- scheduling UI supports. This deterministic repair covers both equal and
-- reversed legacy ranges without deleting meetings or moving their start.
UPDATE "meetings"
SET "endTime" = "startTime" + INTERVAL '1 minute'
WHERE "endTime" <= "startTime";

ALTER TABLE "meetings"
VALIDATE CONSTRAINT "meetings_endTime_after_startTime_check";
