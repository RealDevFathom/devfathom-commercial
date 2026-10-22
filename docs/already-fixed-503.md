# GitHub issue #503: already fixed

Verified against the current branch on 2026-10-22. The reported authorization gap is already
closed, so no application code was changed for this issue.

## Evidence

- `src/server/routers/projects.ts:140-156` accepts the project identity and lifecycle fields, then
  calls `assertProjectAccess(ctx, id, { manage: true })` before `project.update`.
- `src/server/authz.ts:35-46` maps `{ manage: true }` to `canManageProject` and rejects a false result
  with `FORBIDDEN`.
- `src/lib/authz.ts:75-85` defines project management as tenant `ADMIN` or project `LEAD`; an
  ordinary project `MEMBER` does not satisfy that predicate.
- `src/app/(app)/projects/[id]/project-detail-content.tsx:98-102` derives `canManage` from the same
  `ADMIN`/`LEAD` roles, and lines 162-184 render the Edit action only when `canManage` is true.
- `src/server/routers/projects.update-auth.test.ts:53-81` contains focused regression coverage that
  rejects a `MEMBER` before any update and permits a project `LEAD` or tenant `ADMIN`.

Together, the server-side guard enforces the security boundary independently of the UI, while the
UI avoids presenting an unusable Edit action to ordinary project members.
