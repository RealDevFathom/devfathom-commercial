# GitHub issue #508 is already fixed

Issue #508 reports that approved resignations with a future `lastWorkingDay` are
never processed. The current code already implements the missing scheduled
offboarding flow:

- `src/app/api/platform/jobs/process/route.ts:5,24-29` invokes
  `processDueResignationOffboarding()` from the authenticated platform job
  endpoint and includes the sweep result in its response.
- `src/lib/resignations/offboarding.ts:6-15` discovers only organizations with
  an approved, due resignation joined to a user in the same organization.
- `src/lib/resignations/offboarding.ts:36-55` performs each write through
  `withTenantDb(organizationId, ...)`, rechecks that the resignation is approved
  and due, changes only non-inactive users, and increments `tokenVersion` while
  setting the account to `INACTIVE` so existing sessions are revoked.
- `src/lib/resignations/offboarding.ts:58-73` runs the discovery query through
  the platform scope and processes every returned organization in its own tenant
  scope.
- `src/server/routers/resignations.ts:204-214` also immediately deactivates an
  employee (and increments `tokenVersion`) when an approved last working day has
  already arrived, while explicitly delegating future dates to the platform
  worker sweep.
- `src/lib/resignations/offboarding.test.ts:36-49` verifies that discovered
  organizations are processed separately, and lines 51-64 verify the due and
  approved predicates plus atomic account deactivation/session revocation.

The implementation was already present at the start of this issue-verification
work, so no production code or additional tests were needed.
