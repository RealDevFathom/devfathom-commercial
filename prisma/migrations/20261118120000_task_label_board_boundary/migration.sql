-- DEV-190 (#544): a task may carry only labels from its own board.
--
-- Existing links that break this rule are removed, but every removed row is
-- first copied into "task_label_board_repair_backups" in this same
-- transaction, so the repair can be reviewed and undone. Tasks, labels and
-- valid links are never changed.
BEGIN;

-- Repair every tenant, including installations with forced RLS. Scope expires
-- at COMMIT; runtime trigger functions remain SECURITY INVOKER.
SELECT set_config('app.is_platform_admin', 'true', true);
LOCK TABLE tasks, columns, labels, task_labels IN SHARE ROW EXCLUSIVE MODE;

-- Tenant table: same RLS boundary as task_labels. No foreign keys, so a backup
-- survives later deletion of the task or label it names.
CREATE TABLE IF NOT EXISTS "task_label_board_repair_backups" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "labelId" TEXT NOT NULL,
  "taskBoardId" TEXT NOT NULL,
  "labelBoardId" TEXT NOT NULL,
  "removedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "task_label_board_repair_backups_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "task_label_board_repair_backups_organizationId_idx"
  ON "task_label_board_repair_backups" ("organizationId");
ALTER TABLE "task_label_board_repair_backups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_label_board_repair_backups" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "task_label_board_repair_backups";
CREATE POLICY "tenant_isolation" ON "task_label_board_repair_backups"
  USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

-- Back up, then remove, exactly the same set of invalid links. "id" is the
-- original task_labels id, so a re-run never duplicates a backup row.
INSERT INTO "task_label_board_repair_backups"
  ("id", "organizationId", "taskId", "labelId", "taskBoardId", "labelBoardId")
SELECT tl.id, tl."organizationId", tl."taskId", tl."labelId", c."boardId", l."boardId"
FROM task_labels tl
JOIN tasks t ON t.id = tl."taskId"
JOIN columns c ON c.id = t."columnId"
JOIN labels l ON l.id = tl."labelId"
WHERE c."boardId" <> l."boardId"
  OR tl."organizationId" <> t."organizationId"
  OR tl."organizationId" <> c."organizationId"
  OR tl."organizationId" <> l."organizationId"
ON CONFLICT ("id") DO NOTHING;

-- Delete only a link that is still invalid and whose exact row (same id, task
-- and label) is in the backup. Tasks, labels and valid links are never touched.
DELETE FROM task_labels tl
USING "task_label_board_repair_backups" b, tasks t, columns c, labels l
WHERE b.id = tl.id
  AND b."organizationId" = tl."organizationId"
  AND b."taskId" = tl."taskId"
  AND b."labelId" = tl."labelId"
  AND t.id = tl."taskId"
  AND c.id = t."columnId"
  AND l.id = tl."labelId"
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
  -- single, bulk, REST, AI and direct SQL moves at this shared boundary. A link
  -- left behind by a cross-board move is invalid; it is copied to the backup
  -- table in the same statement, so no link is ever removed without a record.
  WITH removed AS (
    DELETE FROM task_labels tl
    WHERE tl."taskId" = NEW.id AND NOT EXISTS (
      SELECT 1 FROM columns c JOIN labels l ON l."boardId" = c."boardId"
      WHERE c.id = NEW."columnId" AND l.id = tl."labelId"
        AND c."organizationId" = NEW."organizationId"
        AND l."organizationId" = NEW."organizationId"
        AND tl."organizationId" = NEW."organizationId"
    )
    RETURNING tl.id, tl."organizationId", tl."taskId", tl."labelId"
  )
  INSERT INTO "task_label_board_repair_backups"
    ("id", "organizationId", "taskId", "labelId", "taskBoardId", "labelBoardId")
  SELECT r.id, r."organizationId", r."taskId", r."labelId",
    COALESCE((SELECT c."boardId" FROM columns c WHERE c.id = NEW."columnId"), ''),
    COALESCE((SELECT l."boardId" FROM labels l WHERE l.id = r."labelId"), '')
  FROM removed r
  ON CONFLICT ("id") DO NOTHING;
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
