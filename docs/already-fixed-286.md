# GitHub issue #286 — already fixed

Verified against the current code on 2026-10-22. No production-code change is
needed: the restaurant invite flow already offers and submits the tenant's role
templates, including the four roles named in the issue.

## File-and-line evidence

- `src/lib/vertical-catalog.ts:990-1038`, `src/lib/vertical-catalog.ts:1104-1117`,
  and `src/lib/vertical-catalog.ts:1142-1147` define the restaurant
  `general-manager`, `branch-manager`, `bar-barista`, and `accountant` templates.
- `src/server/routers/organization-admin.ts:114-120` returns every role belonging
  to the current organization, ordered for display. The organization predicate
  preserves tenant isolation.
- `src/app/(app)/team/team-content.tsx:253-264` loads those tenant role options
  and holds the selected role ID in the invite form state.
- `src/app/(app)/team/team-content.tsx:290-301` sends the selected
  `organizationRoleId` with the invitation request.
- `src/app/(app)/team/team-content.tsx:509-529` renders every returned role as an
  option in the **Restaurant staff role** selector.
- `src/server/routers/team.ts:140-168` accepts the role ID but resolves it only
  when it belongs to the caller's workspace, rejecting cross-tenant or otherwise
  invalid IDs.
- `src/server/routers/team.ts:186-194` stores the validated role ID on the invited
  user's profile.
- `src/app/(app)/team/team-content.test.tsx:48-52` supplies all four reported
  roles to the invite picker, and `src/app/(app)/team/team-content.test.tsx:70-87`
  verifies each one is selectable and submitted.

The existing implementation therefore satisfies the expected behavior, while
the server-side workspace check prevents a submitted role ID from escaping its
tenant boundary.
