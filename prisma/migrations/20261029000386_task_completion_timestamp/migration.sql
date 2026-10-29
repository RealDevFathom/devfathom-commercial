ALTER TABLE "tasks" ADD COLUMN "completedAt" TIMESTAMP(3);

-- Only backfill from an actual recorded completion event. Falling back to
-- tasks.updatedAt would turn a recent edit of old Done work into a completion,
-- which is the defect this column exists to prevent.
UPDATE "tasks" AS t
SET "completedAt" = (
  SELECT a."createdAt"
  FROM "activities" AS a
  WHERE a."entityType" = 'Task'
    AND a."entityId" = t.id
    AND a.type = 'task_completed'
  ORDER BY a."createdAt" DESC
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1
  FROM "columns" AS c
  WHERE c.id = t."columnId"
    AND lower(trim(c.name)) IN ('done', 'complete', 'completed', 'shipped', 'closed')
)
AND EXISTS (
  SELECT 1
  FROM "activities" AS a
  WHERE a."entityType" = 'Task'
    AND a."entityId" = t.id
    AND a.type = 'task_completed'
);

CREATE INDEX "tasks_completedAt_idx" ON "tasks"("completedAt");
