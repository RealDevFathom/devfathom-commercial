-- Keep task assignment and project membership consistent even when the two
-- records are changed concurrently or through a writer other than the REST API.
CREATE OR REPLACE FUNCTION enforce_task_assignee_project_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  membership_id text;
BEGIN
  -- The row lock coordinates with deletion of the membership. If assignment
  -- wins the race, removal waits and its trigger removes the new assignment. If
  -- removal wins, this lookup resumes without a row and rejects the assignment.
  SELECT pm.id
    INTO membership_id
    FROM project_members pm
    JOIN projects p ON p.id = pm."projectId"
    JOIN boards b ON b."projectId" = p.id
    JOIN columns c ON c."boardId" = b.id
    JOIN tasks t ON t."columnId" = c.id
   WHERE t.id = NEW."taskId"
     AND pm."userId" = NEW."userId"
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
  DELETE FROM task_assignees ta
   USING tasks t, columns c, boards b
   WHERE ta."taskId" = t.id
     AND t."columnId" = c.id
     AND c."boardId" = b.id
     AND b."projectId" = OLD."projectId"
     AND ta."userId" = OLD."userId";
  RETURN OLD;
END;
$$;

CREATE TRIGGER project_member_assignment_cleanup
AFTER DELETE ON project_members
FOR EACH ROW
EXECUTE FUNCTION remove_assignments_for_departing_project_member();
