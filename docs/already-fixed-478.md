# GitHub issue #478: already fixed

Verified against the current code on 2026-10-22. No implementation change is
needed: commit `350dd0fbb01d294a092750bae08868988107b981` already replaced the
restaurant landing decision based on `User.role` with an effective-capability
decision.

## Evidence

- `src/app/(app)/dashboard/page.tsx:32-49` opens a tenant-scoped database context
  and evaluates both `admin:access` and `orders:take` through the central `can`
  authorization function. The `orders:take` result is only considered for a
  restaurant user who does not have effective administrator access.
- `src/app/(app)/dashboard/page.tsx:51-57` redirects to `/pos` only when that
  effective `orders:take` decision is true. Otherwise, the restaurant dashboard
  continues rendering, so kitchen, inventory, and finance personas are not sent
  to an unusable POS.
- `src/lib/abac/index.ts:29-58` resolves active per-user overrides and
  organization-role permissions, with a matching `DENY` taking precedence over
  `ALLOW`. `src/lib/abac/index.ts:62-93` requires a tenant-scoped database and
  fails closed when the permission lookup fails.
- `src/lib/abac/policies.ts:163-171` registers `orders:take` as an
  organization-role-driven, default-deny capability rather than a coarse user
  role check.
- `src/app/(app)/dashboard/page.test.tsx:73-92` covers the positive case: an
  effective `orders:take` grant redirects a non-admin restaurant operator to
  `/pos`.
- `src/app/(app)/dashboard/page.test.tsx:94-110` covers the reported regression
  for kitchen, inventory, and finance personas without `orders:take`, asserting
  that they remain on the dashboard.
- `src/app/(app)/dashboard/page.test.tsx:113-129` verifies that an effective
  administrator remains on the restaurant management dashboard even if the
  administrator also has the broader order-taking grant.

Because the requested behavior and focused regression coverage are already on
the current branch, this issue adds documentation only.
