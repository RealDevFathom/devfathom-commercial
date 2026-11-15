BEGIN;

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "tasks_organizationId_completedAt_idx"
  ON "tasks" ("organizationId", "completedAt");

-- Do not backfill from updatedAt: edits/reorders are not completion evidence.
-- Existing Done tasks retain NULL until a genuine exit and re-entry into Done.
-- Enforce this at the model boundary for tRPC (including bulk), REST, AI and imports.
CREATE OR REPLACE FUNCTION task_completion_timestamp() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_done boolean;
  source_done boolean := false;
BEGIN
  SELECT "name" = 'Done' INTO target_done FROM "columns"
    WHERE "id" = NEW."columnId" AND "organizationId" = NEW."organizationId";
  IF TG_OP = 'UPDATE' THEN
    IF NEW."columnId" = OLD."columnId" THEN
      NEW."completedAt" := OLD."completedAt";
      RETURN NEW;
    END IF;
    SELECT "name" = 'Done' INTO source_done FROM "columns"
      WHERE "id" = OLD."columnId" AND "organizationId" = OLD."organizationId";
  END IF;

  IF target_done IS TRUE THEN
    IF TG_OP = 'UPDATE' AND source_done IS TRUE THEN
      NEW."completedAt" := OLD."completedAt";
    ELSE
      NEW."completedAt" := statement_timestamp();
    END IF;
  ELSE
    NEW."completedAt" := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_completion_timestamp ON "tasks";
CREATE TRIGGER task_completion_timestamp
  BEFORE INSERT OR UPDATE OF "columnId" ON "tasks"
  FOR EACH ROW EXECUTE FUNCTION task_completion_timestamp();

-- Renaming a column also changes whether its tasks are Done. Preserve the same
-- invariant without treating ordinary column edits as new completions.
CREATE OR REPLACE FUNCTION column_task_completion_timestamp() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."name" = 'Done') IS DISTINCT FROM (OLD."name" = 'Done') THEN
    UPDATE "tasks"
      SET "completedAt" = CASE WHEN NEW."name" = 'Done' THEN statement_timestamp() ELSE NULL END
      WHERE "columnId" = NEW."id" AND "organizationId" = NEW."organizationId";
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS column_task_completion_timestamp ON "columns";
CREATE TRIGGER column_task_completion_timestamp
  AFTER UPDATE OF "name" ON "columns"
  FOR EACH ROW EXECUTE FUNCTION column_task_completion_timestamp();

COMMIT;
