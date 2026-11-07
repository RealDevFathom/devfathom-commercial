-- #410: /team/stats (and the dashboard and assistant workload summaries) counted
-- a task as completed by its mutable updatedAt, so editing an old Done task made
-- it look like a new completion. Completion now has its own timestamp.
BEGIN;

ALTER TABLE "tasks" ADD COLUMN "completedAt" TIMESTAMP(3);

CREATE INDEX "tasks_completedAt_idx" ON "tasks"("completedAt");

-- Conservative backfill. updatedAt is never copied: it moves on every edit, which
-- is exactly the false completion the issue reports. A task already in the Done
-- column takes the time of its most recent `task_completed` activity, the app's
-- own record of the move into Done. A Done task with no such record keeps NULL:
-- its completion time is unknown, so the stats leave it out of every completion
-- window rather than guess. Tasks outside Done stay NULL.
SELECT set_config('app.is_platform_admin', 'true', true);

UPDATE "tasks" AS t
SET "completedAt" = evidence."completedAt"
FROM (
  SELECT a."organizationId", a."entityId" AS "taskId", MAX(a."createdAt") AS "completedAt"
  FROM "activities" AS a
  WHERE a."type" = 'task_completed' AND a."entityType" = 'Task' AND a."entityId" IS NOT NULL
  GROUP BY a."organizationId", a."entityId"
) AS evidence, "columns" AS c
WHERE evidence."taskId" = t."id"
  AND evidence."organizationId" = t."organizationId"
  AND c."id" = t."columnId"
  AND c."name" = 'Done'
  AND evidence."completedAt" >= t."createdAt";

-- From here on the database keeps completedAt right on every write path (tRPC
-- board, REST, assistant tools, imports, seeds): a task created in Done or moved
-- into Done from another column is stamped with the write time; a task anywhere
-- other than Done has none, so moving out of Done clears it; Done to Done keeps
-- it. A writer may supply an explicit completion time for a task in Done. Ordinary
-- edits never fire this trigger, so they cannot move a completion.
CREATE OR REPLACE FUNCTION public.task_maintain_completed_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  in_done boolean;
  was_done boolean;
BEGIN
  -- "Done" is the column name /team/stats and the dashboard report as Done.
  SELECT c."name" = 'Done' INTO in_done FROM public.columns AS c WHERE c."id" = NEW."columnId";
  IF NOT COALESCE(in_done, false) THEN
    NEW."completedAt" := NULL;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW."completedAt" := COALESCE(NEW."completedAt", timezone('UTC', now()));
    RETURN NEW;
  END IF;

  IF NEW."columnId" IS DISTINCT FROM OLD."columnId"
     AND NEW."completedAt" IS NOT DISTINCT FROM OLD."completedAt" THEN
    SELECT c."name" = 'Done' INTO was_done FROM public.columns AS c WHERE c."id" = OLD."columnId";
    IF NOT COALESCE(was_done, false) THEN
      NEW."completedAt" := timezone('UTC', now());
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "tasks_maintain_completed_at"
BEFORE INSERT OR UPDATE OF "columnId", "completedAt" ON "tasks"
FOR EACH ROW EXECUTE FUNCTION public.task_maintain_completed_at();

COMMIT;
