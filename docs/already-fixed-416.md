# GitHub issue #416: already fixed

Issue #416 is already fixed in the current code, so no application code or test changes are
needed for this follow-up.

## Verification evidence

- `src/server/routers/projects.ts:672-676` resolves authorization before deletion and calls
  `assertTaskAccess(ctx, input.id, { manage: true })`.
- `src/server/authz.ts:64-71` resolves the task's owning project from the task ID and forwards the
  `manage` option to `assertProjectAccess`.
- `src/server/authz.ts:32-41` routes management checks through `canManageProject` and throws
  `FORBIDDEN` when the check fails.
- `src/lib/authz.ts:51-60,75-85` derives membership from the compound project/user key and permits
  project management only for an `ADMIN` or a project `LEAD`, not a `MEMBER`.
- `src/server/routers/projects.delete-task.test.ts:49-68` provides focused regression coverage:
  a `MEMBER` receives `FORBIDDEN` before deletion, while a `LEAD` and an `ADMIN` may delete.
- `src/app/api/v1/tasks/[id]/route.ts:208-219` applies the same `canManageProject` rule to the REST
  delete endpoint.
- `src/lib/ai/tools/tasks.ts:712-724` also keeps the assistant deletion surface behind
  `canManageProject`, with denial-before-delete coverage in
  `src/lib/ai/tools/tasks.delete-task.test.ts:51-73`.

These checks use the project ID resolved from the stored task relationship rather than accepting a
caller-supplied project ID, preserving the existing tenant-scoped database access and preventing a
cross-project authorization bypass.

## Scope

No archive recovery applies to this issue, and no migration, permission lattice, WhatsApp sending,
logging, or database behavior was changed. Per the issue instructions, verification was static and
the existing tests were not run in the dependency-constrained environment.
