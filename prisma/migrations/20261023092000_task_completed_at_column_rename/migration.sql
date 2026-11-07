-- #410: renaming a column changes whether its tasks are Done without updating
-- the task rows. Keep the same completion semantics as moving those tasks.
BEGIN;

CREATE FUNCTION public.column_maintain_task_completed_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE public.tasks
  SET "completedAt" = CASE
    WHEN NEW."name" = 'Done' THEN timezone('UTC', now())
    ELSE NULL
  END
  WHERE "columnId" = NEW."id"
    AND "organizationId" = NEW."organizationId";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "columns_maintain_task_completed_at"
AFTER UPDATE OF "name" ON "columns"
FOR EACH ROW
WHEN (OLD."name" IS DISTINCT FROM NEW."name"
      AND (OLD."name" = 'Done' OR NEW."name" = 'Done'))
EXECUTE FUNCTION public.column_maintain_task_completed_at();

COMMIT;
