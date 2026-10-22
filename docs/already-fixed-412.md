# GitHub issue #412: already fixed

Issue #412 reported that restaurant users always landed on `/dashboard` after
login instead of owners landing on `/restaurant` and waiters landing on `/pos`.

## Verification against the current code

The issue is already fixed on the current branch:

- `src/lib/auth/callback-url.ts:15` deliberately retains `/dashboard` as the
  safe, role-agnostic default callback.
- `src/app/login/page.tsx:40-43` sends an already authenticated user to that
  default dashboard entry point.
- `src/app/(app)/dashboard/page.tsx:20-32` resolves the tenant-aware SSR context,
  detects the `RESTAURANT` vertical, and redirects an authenticated `ADMIN` to
  `/restaurant` and every other restaurant role to `/pos`.
- `src/app/(app)/dashboard/page.test.tsx:60-81` contains focused regression
  coverage for both the owner (`ADMIN`) and waiter (`EMPLOYEE`) destinations. It
  also asserts that dashboard data and setup data are not loaded before the
  redirect.

The redirect occurs only after `createSSRHelpers()` has resolved the current
tenant and its entitlements. It therefore does not weaken tenant isolation or
alter authorization/grant evaluation. No additional code change is required.
