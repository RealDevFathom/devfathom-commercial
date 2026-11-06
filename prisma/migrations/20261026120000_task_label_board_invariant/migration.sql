BEGIN;

-- Cleanup must see every tenant even when the migrator cannot bypass forced
-- RLS. Limit this context to the migration transaction.
SELECT set_config('app.is_platform_admin', 'true', true);

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
DECLARE
  v_column_id text;
  v_attempt integer := 0;
BEGIN
  -- Lock the rows which determine validity. FOR SHARE conflicts with the
  -- FOR UPDATE / FOR NO KEY UPDATE locks taken by board, column, label and task
  -- moves, so an attachment cannot validate against a row version that a
  -- concurrent move is changing.
  --
  -- Lock order matches the application move/reorder protocol (moveTask and
  -- bulk moves lock columns FOR UPDATE, then update tasks): column first, then
  -- its board and the label, and the task last. Taking the task lock first
  -- would deadlock with a concurrent reorder that already holds the column.
  -- If the task changed column before its lock was acquired, roll back this
  -- attempt's subtransaction (releasing its row locks) and retry against the
  -- task's current column, so no stale lock is held out of order.
  LOOP
    v_attempt := v_attempt + 1;
    BEGIN
      SELECT t."columnId" INTO v_column_id FROM "tasks" t WHERE t.id = NEW."taskId";
      IF FOUND THEN
        PERFORM 1 FROM "columns" c WHERE c.id = v_column_id FOR SHARE;
        PERFORM 1
          FROM "columns" c
          JOIN "boards" b ON b.id = c."boardId"
         WHERE c.id = v_column_id
           FOR SHARE OF b;
        PERFORM 1 FROM "labels" l WHERE l.id = NEW."labelId" FOR SHARE;
        PERFORM 1
          FROM "tasks" t
         WHERE t.id = NEW."taskId" AND t."columnId" = v_column_id
           FOR SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'task moved while attaching label' USING ERRCODE = 'DFT01';
        END IF;
      END IF;
    EXCEPTION WHEN SQLSTATE 'DFT01' THEN
      IF v_attempt >= 5 THEN
        RAISE EXCEPTION 'task moved concurrently while attaching label; retry'
          USING ERRCODE = '40001';
      END IF;
      CONTINUE;
    END;
    EXIT;
  END LOOP;

  -- Every row that determines validity is now locked at its latest version.
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

CREATE OR REPLACE FUNCTION enforce_task_labels_after_board_move()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- A board organization change invalidates every existing attachment on the
  -- board because its tasks, columns, and labels still belong to the old
  -- organization. Remove those links before the board update becomes visible.
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" THEN
    DELETE FROM "task_labels" tl
    USING "tasks" t, "columns" c, "labels" l
    WHERE t.id = tl."taskId"
      AND c.id = t."columnId"
      AND l.id = tl."labelId"
      AND (c."boardId" = NEW.id OR l."boardId" = NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER boards_task_label_board_guard
BEFORE UPDATE OF "organizationId" ON "boards"
FOR EACH ROW EXECUTE FUNCTION enforce_task_labels_after_board_move();

COMMIT;
