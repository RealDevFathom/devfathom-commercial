# GitHub issue #9: already fixed

Verified against the current tree on 2026-10-22. The reported platform read-authorization
bypass is no longer present, so no application or test code was changed.

## Evidence

- The role capability matrix is centralized in
  `src/lib/platform/capabilities.ts:3-40`; `canPlatformRole` applies exact capability matching
  (with the existing `SUPER_ADMIN` wildcard) at lines 42-45.
- Every platform console destination is paired with its required capability in
  `src/lib/platform/read-policy.ts:6-69`. Route authorization and role-filtered navigation both
  consume that policy at lines 85-92.
- `requirePlatformRead` authenticates the operator, checks the requested route against that
  operator's role, and denies access before returning an identity in
  `src/lib/platform/page-access.ts:12-26`. A denied operator is sent only to a capability-backed
  fallback; if no safe fallback exists, the helper fails closed with a 403.
- All 14 current `(console)` page entry points call `requirePlatformRead` before their platform
  data read: `src/app/platform/(console)/page.tsx:30`, `audit/page.tsx:12`,
  `catalog/page.tsx:29`, `commercial/page.tsx:19`, `crm/page.tsx:23`,
  `deployments/page.tsx:14`, `health/page.tsx:37`, `jobs/page.tsx:11`,
  `operators/page.tsx:13`, `settings/page.tsx:9`, `support/page.tsx:15`,
  `organizations/page.tsx:12`, `organizations/new/page.tsx:40`, and
  `organizations/[id]/page.tsx:40`.
- The shell derives its navigation from the authenticated role via `platformNavigationFor` in
  `src/components/platform/platform-shell.tsx:141-155`; both the mobile drawer and desktop bar
  render that filtered collection (lines 72-113 and 304-330).
- Focused regression coverage already exists. `src/lib/platform/read-policy.test.ts:12-63`
  defines the complete role/route expectation table, lines 84-95 verify both direct access and
  navigation filtering for every role, and lines 108-126 ensure each data-backed page gates
  before `withPlatformDb`. `src/lib/platform/page-access.test.ts:27-45` covers denied and allowed
  access behavior.

## Static verification performed

Tests were intentionally not executed because the supplied environment is constrained to Bun
1.2.14, has no database, and cannot install dependencies. Static inspection confirmed that every
current console `page.tsx` contains a `requirePlatformRead` call and that each read capability
declared for non-super-admin roles is also referenced by the route policy.

No migration, tenant-scoping change, pharmacy authorization change, or logging change is needed.
