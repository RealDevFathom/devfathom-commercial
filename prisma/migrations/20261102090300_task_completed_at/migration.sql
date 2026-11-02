-- DEV-250 / #450: Task.completedAt — when a task entered a done column.
--
-- /team/stats counted a task as completed by its mutable "updatedAt", so editing
-- an old Done task looked like a new completion and skewed velocity and cycle
-- time. From now on the application (src/lib/task-completion.ts) sets
-- "completedAt" when a task enters a done column (created there, moved in, or its
-- column renamed to a done name), keeps it across done-to-done moves, and clears
-- it when the task leaves done. A done column is one whose name is, ignoring
-- case, Done, Complete, Completed, Shipped or Closed — the same list as the app.
--
-- Backfill: every task currently in a done column gets the best evidence of when
-- it ENTERED done. Copying "updatedAt" wholesale would preserve exactly the
-- false positive this fixes, so "updatedAt" is only the last resort.
--   Evidence, per task (column moves are classified by the target column's
--   current name; renames are not replayed):
--   * exits  — tRPC projects.moveTask / projects.bulkMoveTasks and assistant
--              task.move audit rows whose target is NOT a done column (or no
--              longer exists). The latest one bounds the current done stint.
--   1. the latest "task_completed" activity after the latest exit. The app logs
--      it only when a task enters done from a non-done column, so the latest one
--      starts the current stint even when an exit between two went unrecorded.
--   2. if no exit was ever recorded and the task was demonstrably created straight
--      into its done column (tRPC projects.createTask audit row by the creator,
--      same column and title, within a minute of creation; or an assistant
--      task.create audit row naming a done column): its "createdAt".
--   3. the earliest recorded move into a done column after the latest exit.
--   4. LAST RESORT, only when none of the above exists (e.g. REST moves, whose
--      audit rows carry no body, Trello imports, seeds, tasks older than the
--      audit trail): "updatedAt". It can overstate how recent the completion
--      is, but never understates it.
--   The result is capped at "updatedAt": entering done is itself a write.
-- Tasks outside done columns keep NULL.
--
-- Idempotent: the column and index are added only when absent, and the backfill
-- writes only tasks whose "completedAt" is still NULL, so a second run never
-- overwrites a value the first run or the application already set.

BEGIN;

-- tasks, columns, activities and audit_logs are under FORCE ROW LEVEL SECURITY.
-- Set this in its own statement so the policies see it during the UPDATE; the
-- bypass is transaction-local and is cleared by COMMIT.
SELECT set_config('app.is_platform_admin', 'true', true);

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "tasks_organizationId_completedAt_idx" ON "tasks"("organizationId", "completedAt");

WITH done_tasks AS (
  SELECT t."id", t."organizationId", t."columnId", t."title", t."createdById",
         t."createdAt", t."updatedAt"
  FROM "tasks" t
  JOIN "columns" c ON c."id" = t."columnId"
  WHERE lower(c."name") IN ('done', 'complete', 'completed', 'shipped', 'closed')
    AND t."completedAt" IS NULL
),
moves AS (
  -- In-app drag / move of one task.
  SELECT d."id" AS task_id, a."createdAt" AS at,
         COALESCE(lower(target."name") IN ('done', 'complete', 'completed', 'shipped', 'closed'), false) AS into_done
  FROM done_tasks d
  JOIN "audit_logs" a
    ON a."organizationId" = d."organizationId"
   AND a."action" = 'projects.moveTask'
   AND a."source" = 'TRPC'
   AND a."outcome" = 'SUCCESS'
   AND a."input"->>'taskId' = d."id"
  LEFT JOIN "columns" target ON target."id" = a."input"->>'targetColumnId'
  UNION ALL
  -- In-app bulk move of selected tasks.
  SELECT d."id", a."createdAt",
         COALESCE(lower(target."name") IN ('done', 'complete', 'completed', 'shipped', 'closed'), false)
  FROM done_tasks d
  JOIN "audit_logs" a
    ON a."organizationId" = d."organizationId"
   AND a."action" = 'projects.bulkMoveTasks'
   AND a."source" = 'TRPC'
   AND a."outcome" = 'SUCCESS'
   AND jsonb_typeof(a."input"->'taskIds') = 'array'
   AND a."input"->'taskIds' @> jsonb_build_array(d."id")
  LEFT JOIN "columns" target ON target."id" = a."input"->>'targetColumnId'
  UNION ALL
  -- AI assistant move (its audit row records column names, not ids).
  SELECT d."id", a."createdAt",
         COALESCE(lower(a."changes"->'column'->>'after') IN ('done', 'complete', 'completed', 'shipped', 'closed'), false)
  FROM done_tasks d
  JOIN "audit_logs" a
    ON a."organizationId" = d."organizationId"
   AND a."action" = 'assistant.task.move'
   AND a."targetType" = 'Task'
   AND a."targetId" = d."id"
),
last_exit AS (
  SELECT task_id, max(at) AS at FROM moves WHERE NOT into_done GROUP BY task_id
),
evidence AS (
  SELECT d."id",
         COALESCE(
           -- 1. latest completion activity in the current stint
           (SELECT max(act."createdAt")
              FROM "activities" act
             WHERE act."organizationId" = d."organizationId"
               AND act."entityType" = 'Task'
               AND act."entityId" = d."id"
               AND act."type" = 'task_completed'
               AND act."createdAt" > COALESCE(le.at, '-infinity'::timestamp)),
           -- 2. created straight into done and never recorded leaving it
           CASE WHEN le.at IS NULL AND (
                  EXISTS (
                    SELECT 1 FROM "audit_logs" a
                     WHERE a."organizationId" = d."organizationId"
                       AND a."action" = 'projects.createTask'
                       AND a."source" = 'TRPC'
                       AND a."outcome" = 'SUCCESS'
                       AND a."actorId" = d."createdById"
                       AND a."input"->>'columnId' = d."columnId"
                       AND a."input"->>'title' = d."title"
                       AND a."createdAt" BETWEEN d."createdAt" AND d."createdAt" + interval '1 minute')
                  OR EXISTS (
                    SELECT 1 FROM "audit_logs" a
                     WHERE a."organizationId" = d."organizationId"
                       AND a."action" = 'assistant.task.create'
                       AND a."targetType" = 'Task'
                       AND a."targetId" = d."id"
                       AND lower(a."metadata"->>'column') IN ('done', 'complete', 'completed', 'shipped', 'closed')))
                THEN d."createdAt" END,
           -- 3. earliest recorded move into done in the current stint
           (SELECT min(m.at)
              FROM moves m
             WHERE m.task_id = d."id"
               AND m.into_done
               AND m.at > COALESCE(le.at, '-infinity'::timestamp)),
           -- 4. last resort: no evidence of when it entered done
           d."updatedAt"
         ) AS entered_done_at,
         d."updatedAt"
  FROM done_tasks d
  LEFT JOIN last_exit le ON le.task_id = d."id"
)
UPDATE "tasks" t
SET "completedAt" = LEAST(e.entered_done_at, e."updatedAt")
FROM evidence e
WHERE e."id" = t."id"
  AND t."completedAt" IS NULL;

COMMIT;
