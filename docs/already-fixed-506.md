# GitHub issue #506 is already fixed

Issue #506 reported that callers could attach a task label from a different
project board. The current code already enforces the required exact-board
invariant on both reported write paths:

- `src/server/routers/projects.ts:1607-1623` first authorizes access to the
  task, reads that task's board ID, and rejects the mutation unless the supplied
  label belongs to that exact board before creating the `TaskLabel`.
- `src/app/api/v1/tasks/route.ts:78-109` loads the selected column and board,
  authorizes the board's project, and rejects task creation when any supplied
  label ID is unavailable on the selected column's exact board.
- `src/lib/task-labels.ts:13-24` implements the shared check as a board-scoped
  count over the unique requested label IDs, so merely knowing an existing
  label ID is insufficient.
- `src/lib/task-labels.test.ts:4-25` contains focused regression coverage for a
  foreign-board label and for duplicate label IDs.

The fix is present in commit `536859e` (`fix(#506)`) on the current branch, so
no additional code or schema change is needed.
