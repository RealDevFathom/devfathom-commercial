BEGIN;

-- Repair every tenant, including installations with forced RLS. Scope expires
-- at COMMIT; runtime trigger functions remain SECURITY INVOKER.
SELECT set_config('app.is_platform_admin', 'true', true);
LOCK TABLE tasks, columns, labels, task_labels IN SHARE ROW EXCLUSIVE MODE;

DELETE FROM task_labels tl
USING tasks t, columns c, labels l
WHERE tl."taskId" = t.id AND t."columnId" = c.id AND tl."labelId" = l.id
  AND (c."boardId" <> l."boardId"
    OR tl."organizationId" <> t."organizationId"
    OR tl."organizationId" <> c."organizationId"
    OR tl."organizationId" <> l."organizationId");

CREATE OR REPLACE FUNCTION enforce_task_label_board() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  task_column text;
  task_organization text;
BEGIN
  -- A real row version (without changing updatedAt) serializes every attachment
  -- with task moves. Unlike a read-only lock, it also makes stale REPEATABLE READ
  -- movers fail serialization instead of missing a newly attached label.
  UPDATE tasks SET "updatedAt" = "updatedAt"
    WHERE id = NEW."taskId"
    RETURNING "columnId", "organizationId" INTO task_column, task_organization;

  IF NOT FOUND OR task_organization IS DISTINCT FROM NEW."organizationId"
    OR NOT EXISTS (
      SELECT 1 FROM columns c JOIN labels l ON l."boardId" = c."boardId"
      WHERE c.id = task_column AND l.id = NEW."labelId"
        AND c."organizationId" = NEW."organizationId"
        AND l."organizationId" = NEW."organizationId"
    ) THEN
    RAISE EXCEPTION 'Label must belong to the task board.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_label_board_guard ON task_labels;
CREATE TRIGGER task_label_board_guard BEFORE INSERT OR UPDATE ON task_labels
  FOR EACH ROW EXECUTE FUNCTION enforce_task_label_board();

CREATE OR REPLACE FUNCTION remove_moved_task_labels() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- The task update holds the same row lock as the attachment guard. Cover
  -- single, bulk, REST, AI and direct SQL moves at this shared boundary.
  DELETE FROM task_labels tl
  WHERE tl."taskId" = NEW.id AND NOT EXISTS (
    SELECT 1 FROM columns c JOIN labels l ON l."boardId" = c."boardId"
    WHERE c.id = NEW."columnId" AND l.id = tl."labelId"
      AND c."organizationId" = NEW."organizationId"
      AND l."organizationId" = NEW."organizationId"
      AND tl."organizationId" = NEW."organizationId"
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_move_label_cleanup ON tasks;
CREATE TRIGGER task_move_label_cleanup AFTER UPDATE OF "columnId" ON tasks
  FOR EACH ROW WHEN (OLD."columnId" IS DISTINCT FROM NEW."columnId")
  EXECUTE FUNCTION remove_moved_task_labels();

CREATE OR REPLACE FUNCTION preserve_label_board_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- The application moves tasks, never columns or label definitions. Keeping
  -- these owners immutable prevents changing the board behind existing links.
  IF NEW."boardId" IS DISTINCT FROM OLD."boardId" THEN
    RAISE EXCEPTION 'Board ownership cannot be changed.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS column_board_ownership_guard ON columns;
CREATE TRIGGER column_board_ownership_guard BEFORE UPDATE OF "boardId" ON columns
  FOR EACH ROW EXECUTE FUNCTION preserve_label_board_ownership();
DROP TRIGGER IF EXISTS label_board_ownership_guard ON labels;
CREATE TRIGGER label_board_ownership_guard BEFORE UPDATE OF "boardId" ON labels
  FOR EACH ROW EXECUTE FUNCTION preserve_label_board_ownership();

COMMIT;
