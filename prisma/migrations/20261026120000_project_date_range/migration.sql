-- Repair ranges accepted before application validation was introduced, then
-- enforce the invariant for every writer and for concurrent partial updates.
UPDATE projects
SET "endDate" = "startDate"
WHERE "startDate" IS NOT NULL
  AND "endDate" IS NOT NULL
  AND "endDate" < "startDate";

ALTER TABLE projects
ADD CONSTRAINT projects_date_range_check
CHECK ("startDate" IS NULL OR "endDate" IS NULL OR "endDate" >= "startDate");
