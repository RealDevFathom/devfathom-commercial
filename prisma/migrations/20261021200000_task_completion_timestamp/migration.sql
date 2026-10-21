ALTER TABLE "tasks" ADD COLUMN "completedAt" TIMESTAMP(3);

-- Preserve the best timestamp available for existing completed tasks. Future
-- edits no longer change this value because it is separate from updatedAt.
UPDATE "tasks" AS t
SET "completedAt" = t."updatedAt"
FROM "columns" AS c
WHERE t."columnId" = c.id
  AND lower(c.name) IN ('done', 'complete', 'completed', 'shipped', 'closed');

CREATE INDEX "tasks_completedAt_idx" ON "tasks"("completedAt");
