-- Keep task assignment and project membership consistent even when the two
-- records are changed concurrently or through a writer other than the REST API.
-- Exclude writes to every participant before taking the cleanup snapshot. This
-- prevents a pre-trigger writer from committing an invalid row after cleanup
-- but before the triggers below are installed. Keep this order stable for any
-- future migration which needs to lock the same invariant participants.
LOCK TABLE task_assignees, project_members, tasks IN SHARE ROW EXCLUSIVE MODE;

-- The migration role is subject to FORCE ROW LEVEL SECURITY on task_assignees,
-- project_members, tasks and audit_logs. Without the platform-admin flag the
-- cleanup below would silently match zero rows. Keep set_config as its own
-- statement: a flag set inside the same statement is not visible to RLS.
SELECT set_config('app.is_platform_admin', 'true', true);

-- Remove invalid rows created before this invariant existed, retaining a
-- tenant-scoped audit record for every discarded assignment.
WITH removed AS (
  DELETE FROM task_assignees ta
   WHERE NOT EXISTS (
     SELECT 1
       FROM tasks t
       JOIN columns c ON c.id = t."columnId"
       JOIN boards b ON b.id = c."boardId"
       JOIN project_members pm
         ON pm."projectId" = b."projectId"
        AND pm."userId" = ta."userId"
      WHERE t.id = ta."taskId"
   )
   RETURNING ta.*
)
INSERT INTO audit_logs (
  id, "organizationId", "actorType", source, category, operation, action,
  "targetType", "targetId", metadata
)
SELECT gen_random_uuid()::text, "organizationId", 'SYSTEM', 'SYSTEM', 'TASK',
       'DELETE', 'task.assignee_membership_cleanup', 'Task', "taskId",
       jsonb_build_object('reason', 'migration_cleanup', 'userId', "userId",
                          'assignmentId', id)
  FROM removed;

CREATE OR REPLACE FUNCTION enforce_task_assignee_project_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  membership_id text;
BEGIN
  -- The task lock coordinates with moves, and the membership lock coordinates
  -- with deletion or identity changes. In either case the later operation sees
  -- and repairs/rejects the assignment using the final project membership.
  SELECT pm.id
    INTO membership_id
    FROM project_members pm
    JOIN projects p ON p.id = pm."projectId"
    JOIN boards b ON b."projectId" = p.id
    JOIN columns c ON c."boardId" = b.id
    JOIN tasks t ON t."columnId" = c.id
   WHERE t.id = NEW."taskId"
     AND pm."userId" = NEW."userId"
   FOR SHARE OF t
   FOR KEY SHARE OF pm;

  IF membership_id IS NULL THEN
    RAISE EXCEPTION 'Task assignee must be a member of the task project'
      USING ERRCODE = '23514',
            CONSTRAINT = 'task_assignee_project_membership';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER task_assignee_project_membership_check
BEFORE INSERT OR UPDATE OF "taskId", "userId" ON task_assignees
FOR EACH ROW
EXECUTE FUNCTION enforce_task_assignee_project_membership();

CREATE OR REPLACE FUNCTION remove_assignments_for_departing_project_member()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  WITH removed AS (
    DELETE FROM task_assignees ta
     USING tasks t, columns c, boards b
     WHERE ta."taskId" = t.id
       AND t."columnId" = c.id
       AND c."boardId" = b.id
       AND b."projectId" = OLD."projectId"
       AND ta."userId" = OLD."userId"
     RETURNING ta.*
  )
  INSERT INTO audit_logs (
    id, "organizationId", "actorType", source, category, operation, action,
    "targetType", "targetId", metadata
  )
  SELECT gen_random_uuid()::text, "organizationId", 'SYSTEM', 'SYSTEM', 'TASK',
         'DELETE', 'task.assignee_membership_cleanup', 'Task', "taskId",
         jsonb_build_object('reason', 'project_member_departure', 'userId', "userId",
                            'assignmentId', id, 'projectId', OLD."projectId",
                            'initiatingUserId', NULLIF(current_setting('app.current_user_id', true), ''))
    FROM removed;
  RETURN OLD;
END;
$$;

CREATE TRIGGER project_member_assignment_cleanup_on_delete
AFTER DELETE ON project_members
FOR EACH ROW
EXECUTE FUNCTION remove_assignments_for_departing_project_member();

CREATE TRIGGER project_member_assignment_cleanup_on_update
AFTER UPDATE OF "projectId", "userId" ON project_members
FOR EACH ROW
WHEN (
  OLD."projectId" IS DISTINCT FROM NEW."projectId"
  OR OLD."userId" IS DISTINCT FROM NEW."userId"
)
EXECUTE FUNCTION remove_assignments_for_departing_project_member();

CREATE OR REPLACE FUNCTION remove_invalid_assignments_after_task_move()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  WITH removed AS (
    DELETE FROM task_assignees ta
     WHERE ta."taskId" = NEW.id
       AND NOT EXISTS (
         SELECT 1
           FROM columns c
           JOIN boards b ON b.id = c."boardId"
           JOIN project_members pm
             ON pm."projectId" = b."projectId"
            AND pm."userId" = ta."userId"
          WHERE c.id = NEW."columnId"
       )
     RETURNING ta.*
  )
  INSERT INTO audit_logs (
    id, "organizationId", "actorType", source, category, operation, action,
    "targetType", "targetId", metadata
  )
  SELECT gen_random_uuid()::text, "organizationId", 'SYSTEM', 'SYSTEM', 'TASK',
         'DELETE', 'task.assignee_membership_cleanup', 'Task', "taskId",
         jsonb_build_object('reason', 'task_project_move', 'userId', "userId",
                            'assignmentId', id, 'columnId', NEW."columnId",
                            'initiatingUserId', NULLIF(current_setting('app.current_user_id', true), ''))
    FROM removed;
  RETURN NEW;
END;
$$;

CREATE TRIGGER task_move_assignment_cleanup
AFTER UPDATE OF "columnId" ON tasks
FOR EACH ROW
WHEN (OLD."columnId" IS DISTINCT FROM NEW."columnId")
EXECUTE FUNCTION remove_invalid_assignments_after_task_move();
