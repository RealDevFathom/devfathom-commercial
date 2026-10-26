-- Remove links that predate enforcement and cross a board boundary. Keeping them
-- would continue to expose another board's taxonomy through task responses.
DELETE FROM "task_labels" tl
USING "tasks" t, "columns" c, "labels" l
WHERE tl."taskId" = t.id
  AND t."columnId" = c.id
  AND tl."labelId" = l.id
  AND (
    c."boardId" <> l."boardId"
    OR t."organizationId" <> l."organizationId"
    OR tl."organizationId" <> t."organizationId"
  );

CREATE OR REPLACE FUNCTION enforce_task_label_board()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "tasks" t
    JOIN "columns" c ON c.id = t."columnId"
    JOIN "labels" l ON l.id = NEW."labelId"
    WHERE t.id = NEW."taskId"
      AND c."boardId" = l."boardId"
      AND t."organizationId" = l."organizationId"
      AND t."organizationId" = NEW."organizationId"
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
  USING "labels" l, "columns" c
  WHERE tl."taskId" = NEW.id
    AND l.id = tl."labelId"
    AND c.id = NEW."columnId"
    AND (l."boardId" <> c."boardId" OR l."organizationId" <> NEW."organizationId");
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
