# GitHub issue #395: already fixed

Verified against the current code on 2026-10-22.

The reported cross-project task-move leak is already fixed:

- `src/server/routers/projects.ts:687-688` checks access to both the task and the
  destination column before moving anything.
- `src/server/routers/projects.ts:721-725` reads the destination project inside
  the move transaction.
- `src/server/routers/projects.ts:750-760` detects a cross-project move and
  deletes every assignment whose user is not a member of the destination
  project.
- `src/server/routers/projects.ts:766-773` restricts destination-column default
  assignees to destination-project members before adding them.
- `src/server/routers/projects.move-task.test.ts:72-96` contains a focused
  regression test proving that unauthorized assignees are removed.
- `src/server/routers/projects.move-task.test.ts:98-107` proves that moves
  between boards in the same project preserve assignees.
- `src/app/api/v1/tasks/[id]/route.ts:129-213` performs the equivalent REST
  move, assignee cleanup, and destination-default assignment in a serializable
  transaction so a failure cannot persist a partial move and concurrent moves
  cannot silently interleave.
- `src/app/api/v1/tasks/[id]/route.test.ts:68-131` verifies both the
  destination-membership cleanup and that move writes do not escape an aborted
  serializable transaction.

Together, these checks prevent a source-project-only assignee from remaining on
a task after it moves to another project, so that user can no longer receive the
destination board and project identifiers through `getMyTasks` as described in
the issue.
