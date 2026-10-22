# GitHub issue #410: already fixed

Issue #410 reports that `/team/stats` treated a task's mutable `updatedAt` as its
completion time, so editing an old task in **Done** could make it appear newly
completed.

Static verification against the current branch shows that the issue is already
fixed:

- `Task` has a separate nullable `completedAt` value, while `updatedAt` remains
  Prisma's automatic modification timestamp (`prisma/schema.prisma:3212-3217`).
- The completion-transition helper sets the timestamp only when work enters a
  done column, clears it when work leaves one, and returns `undefined` for a
  done-to-done move so the stored completion time is not rewritten
  (`src/lib/task-completion.ts:3-14`).
- Single-task moves persist the helper's transition result
  (`src/server/routers/projects.ts:700-711,746-749`), and bulk moves apply the
  same rule (`src/server/routers/projects.ts:814-839`). Tasks created directly
  in a done column also receive a completion timestamp
  (`src/server/routers/projects.ts:581-590`).
- Weekly completion queries use `completedAt`, not `updatedAt`
  (`src/server/routers/team-stats.ts:107-130`). Cycle-time queries and
  calculations likewise use `completedAt`
  (`src/server/routers/team-stats.ts:142-155,288-293`).
- The 30-day velocity query and day bucketing use `completedAt`
  (`src/server/routers/team-stats.ts:195-202,365-378`). Therefore a later edit,
  which changes only `updatedAt`, cannot move an old completion into a current
  reporting window.
- Focused unit coverage already checks entering, leaving, and moving between
  done columns, plus ordinary moves (`src/lib/task-completion.test.ts:4-21`).

No production code, migration, or test changes are needed for this issue.
