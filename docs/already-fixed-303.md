# GitHub issue #303: already fixed

Issue #303 reports that `organizationAdmin.updateMember` can remove the final
active administrator by demoting them or changing their status. The current
code already prevents that outcome:

- `src/server/routers/organization-admin.ts:484-488` loads the target member
  with an `organizationId` predicate, preserving tenant isolation.
- `src/server/routers/organization-admin.ts:505-524` treats either a role
  change away from `ADMIN` or a status change away from `ACTIVE` as removal of
  an active administrator. It locks the tenant's organization row, counts that
  tenant's active administrators, and rejects the update when the count is one.
- `src/server/routers/organization-admin.ts:528-539` performs the member update
  inside the same transaction and increments `tokenVersion` for accepted role
  or status changes.
- `src/server/routers/organization-admin.members.test.ts:250-290` covers both
  last-admin demotion and last-admin deactivation, including the organization
  lock occurring before the count and the absence of an update after rejection.
- `src/server/routers/organization-admin.members.test.ts:292-318` models two
  concurrent demotions as serialized transactions, and
  `src/server/routers/organization-admin.members.test.ts:339-345` verifies that
  exactly one succeeds and one active administrator remains.

No production-code port is needed. The existing guard is broader than the
reported self-demotion case because it protects the last active administrator
regardless of which administrator initiates the update.
