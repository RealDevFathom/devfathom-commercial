BEGIN;

-- Prevent an old application instance from writing a link after the cleanup's
-- snapshot but before the guards are installed. The lock is held through the
-- whole migration and conflicts with normal inserts, updates, and deletes.
LOCK TABLE "task_labels", "tasks", "columns", "labels", "boards"
IN SHARE ROW EXCLUSIVE MODE;

-- Remove links that predate enforcement and fail the same board and
-- organization predicate as the insert/update guard below. Keeping them would
-- continue to expose another board's taxonomy through task responses.
DELETE FROM "task_labels" tl
USING "tasks" t, "columns" c, "boards" b, "labels" l
WHERE tl."taskId" = t.id
  AND t."columnId" = c.id
  AND c."boardId" = b.id
  AND tl."labelId" = l.id
  AND (
    c."boardId" <> l."boardId"
    OR t."organizationId" <> l."organizationId"
    OR t."organizationId" <> c."organizationId"
    OR t."organizationId" <> b."organizationId"
    OR tl."organizationId" <> t."organizationId"
  );

CREATE OR REPLACE FUNCTION enforce_task_label_board()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Lock the rows which determine validity. FOR SHARE conflicts with the
  -- FOR NO KEY UPDATE lock taken by board/column moves, so an attachment
  -- cannot validate against a row version that a concurrent move is changing.
  -- PostgreSQL then follows the updated row and rechecks this predicate.
  IF NOT EXISTS (
    SELECT 1
    FROM "tasks" t
    JOIN "columns" c ON c.id = t."columnId"
    JOIN "boards" b ON b.id = c."boardId"
    JOIN "labels" l ON l.id = NEW."labelId"
    WHERE t.id = NEW."taskId"
      AND c."boardId" = l."boardId"
      AND t."organizationId" = l."organizationId"
      AND t."organizationId" = c."organizationId"
      AND t."organizationId" = b."organizationId"
      AND t."organizationId" = NEW."organizationId"
    FOR SHARE OF t, c, b, l
  ) THEN
    RAISE EXCEPTION 'task label must belong to the task board and organization'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER task_labels_board_guard
BEFORE INSERT OR UPDATE OF "taskId", "labelId", "organizationId" ON "task_labels"
FOR EACH ROW EXECUTE FUNCTION enforce_task_label_board();

CREATE OR REPLACE FUNCTION enforce_task_labels_after_task_move()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Moving tasks between boards is supported. Drop labels that are local to
  -- the old board rather than either blocking that feature or retaining an
  -- invalid association.
  DELETE FROM "task_labels" tl
  USING "labels" l, "columns" c, "boards" b
  WHERE tl."taskId" = NEW.id
    AND l.id = tl."labelId"
    AND c.id = NEW."columnId"
    AND b.id = c."boardId"
    AND (
      l."boardId" <> c."boardId"
      OR NEW."organizationId" <> c."organizationId"
      OR NEW."organizationId" <> b."organizationId"
      OR NEW."organizationId" <> l."organizationId"
      OR NEW."organizationId" <> tl."organizationId"
    );
  RETURN NEW;
END;
$$;

CREATE TRIGGER tasks_label_board_guard
BEFORE UPDATE OF "columnId", "organizationId" ON "tasks"
FOR EACH ROW EXECUTE FUNCTION enforce_task_labels_after_task_move();

CREATE OR REPLACE FUNCTION enforce_task_labels_after_label_move()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM "task_labels" tl
  USING "tasks" t, "columns" c
  WHERE tl."labelId" = NEW.id
    AND t.id = tl."taskId"
    AND c.id = t."columnId"
    AND (c."boardId" <> NEW."boardId" OR t."organizationId" <> NEW."organizationId");
  RETURN NEW;
END;
$$;

CREATE TRIGGER labels_task_board_guard
BEFORE UPDATE OF "boardId", "organizationId" ON "labels"
FOR EACH ROW EXECUTE FUNCTION enforce_task_labels_after_label_move();

CREATE OR REPLACE FUNCTION enforce_task_labels_after_column_move()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM "task_labels" tl
  USING "tasks" t, "labels" l, "boards" b
  WHERE t."columnId" = NEW.id
    AND tl."taskId" = t.id
    AND l.id = tl."labelId"
    AND b.id = NEW."boardId"
    AND (
      l."boardId" <> NEW."boardId"
      OR NEW."organizationId" <> b."organizationId"
      OR t."organizationId" <> NEW."organizationId"
      OR l."organizationId" <> NEW."organizationId"
      OR tl."organizationId" <> NEW."organizationId"
    );
  RETURN NEW;
END;
$$;

CREATE TRIGGER columns_task_label_board_guard
BEFORE UPDATE OF "boardId", "organizationId" ON "columns"
FOR EACH ROW EXECUTE FUNCTION enforce_task_labels_after_column_move();

COMMIT;
