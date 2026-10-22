# Restaurant staff gap follow-up — 2026-10-22

## Verification and issue screening

The three highest-impact findings in `rgap-restaurant-staff-20261022.md` were rechecked against the
current branch before changes were made. All three were still present:

1. **Branch-limited eligible-user directory:** `listEligibleUsers` still selected every user in the
   organization and returned an unscoped linked staff profile.
2. **Secondary-branch staff visibility:** `listDirectory` and `list` still filtered only on
   `primaryBranchId`, despite role holdings and direct capability overrides being branch links in
   the authorization model.
3. **Non-primary device credentials:** the credential form still forced the device selector to the
   staff profile's primary branch rather than allowing an explicit authorized branch choice.

No finding was skipped as already fixed. Open-issue screening could not establish a matching issue:
this checkout has no Git remote and `gh issue list --state open --limit 100` cannot identify a
repository without GitHub authentication. This records the screening limitation rather than
asserting that a private tracker contains no related issue.

## Changes

- Scoped `listEligibleUsers` for branch managers to unlinked organization users or users whose
  linked profile has a primary assignment, role holding, or direct capability override in an
  authorized branch. The nested profile selection uses the same scope so an inaccessible linkage
  is not disclosed (`src/server/routers/restaurant-staff.ts:263-307`).
- Made the active directory and management list resolve staff through primary assignments, role
  holdings, and direct capability overrides. The management response returns only visible effective
  branch IDs and suppresses out-of-scope primary-branch details
  (`src/server/routers/restaurant-staff.ts:229-261`,
  `src/server/routers/restaurant-staff.ts:319-377`).
- Updated the Staff screen's branch filter to use effective branch membership and added an explicit
  device-branch selector. Branch managers see only the staff member's visible linked branches;
  organization-wide administrators can choose any authorized branch
  (`src/components/restaurant/restaurant-staff-console.tsx:171-184`,
  `src/components/restaurant/restaurant-staff-console.tsx:413-425`,
  `src/components/restaurant/restaurant-staff-console.tsx:591-651`).
- Added behavioral router coverage for eligible-user isolation and secondary-role membership
  (`src/server/routers/restaurant-staff.test.ts:186-258`) and component coverage for choosing a
  secondary branch's device (`src/components/restaurant/restaurant-staff-console.test.tsx:314-330`).

## Validation limitation

The requested behavioral tests were written by exercising the router and rendered component; no
new source-text assertion was added. The environment cannot execute Vitest because dependencies are
not installed and the npm registry responds with HTTP 403. Formatting and `git diff --check` were
run locally.
