-- WHA-1187: intraday SOP recurrence. Existing assignments remain unchanged;
-- startDate/endDate continue to be the inclusive effective-date window.
ALTER TYPE "RestaurantSopRecurrenceFrequency" ADD VALUE 'INTERVAL';

ALTER TABLE "restaurant_sop_assignments"
  ADD COLUMN "intervalEndTimeMinutes" INTEGER,
  ADD COLUMN "supersedesAssignmentId" TEXT,
  ADD COLUMN "supersededAt" TIMESTAMP(3);

ALTER TABLE "restaurant_sop_assignments"
  ADD CONSTRAINT "restaurant_sop_assignments_interval_time_check" CHECK (
    ("frequency" = 'INTERVAL' AND "intervalEndTimeMinutes" IS NOT NULL
      AND "intervalEndTimeMinutes" BETWEEN 0 AND 1439
      AND "intervalEndTimeMinutes" > "dueTimeMinutes")
    OR
    ("frequency" <> 'INTERVAL' AND "intervalEndTimeMinutes" IS NULL)
  );

ALTER TABLE "restaurant_sop_assignments"
  ADD CONSTRAINT "restaurant_sop_assignments_interval_minimum_check" CHECK (
    "frequency" <> 'INTERVAL' OR "interval" >= 15
  ),
  ADD CONSTRAINT "restaurant_sop_assignments_interval_weekdays_check" CHECK (
    "frequency" <> 'INTERVAL' OR cardinality("daysOfWeek") > 0
  ),
  ADD CONSTRAINT "restaurant_sop_assignments_supersedes_fkey"
    FOREIGN KEY ("supersedesAssignmentId") REFERENCES "restaurant_sop_assignments"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "restaurant_sop_assignments_supersedesAssignmentId_key"
  ON "restaurant_sop_assignments"("supersedesAssignmentId");
CREATE INDEX "restaurant_sop_assignments_supersededAt_idx"
  ON "restaurant_sop_assignments"("supersededAt");

DROP INDEX "restaurant_sop_occurrences_assignmentId_businessDate_key";
CREATE UNIQUE INDEX "restaurant_sop_occurrences_assignmentId_dueAt_key"
  ON "restaurant_sop_occurrences"("assignmentId", "dueAt");
