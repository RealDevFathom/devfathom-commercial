# GitHub issue #464: archive recovery is already present

Issue #464 asks whether the two commits formerly on `wip/WHA-225-dirty`
(`f8433904` and the worktree snapshot `541bd083`) should be recovered from
`archive/wip/WHA-225-dirty`. No archive code needs to be ported: the valuable
feature described by that branch—restaurant SOP job roles, person/role assignee
targets, and role claim pools—is already implemented on `main`.

## Current-code evidence

- `src/lib/restaurant/job-roles.ts:8-31` defines restaurant job roles as
  branch-scoped, many-to-many staff-profile duties and explicitly makes role
  capability and pool eligibility additive across all held roles.
- `src/lib/restaurant/job-roles.ts:295-350` implements idempotent, audited role
  grants, while `src/lib/restaurant/job-roles.ts:392-430` updates roles only for
  the selected branch.
- `src/lib/restaurant/sop-assignment.ts:7-26` documents and implements the two
  simultaneous assignment modes: a direct `PERSON` assignee and an unclaimed
  `ROLE` pool, with occurrence ownership frozen at generation time.
- `src/lib/restaurant/sop-assignment.ts:42-79` provides the discriminated target
  type and its mutually exclusive persistence projection.
- `src/lib/restaurant/sop-assignment.ts:235-259` limits the claimable pool query
  to active roles the staff member holds at the requested branch.
- `src/lib/restaurant/job-roles.db.test.ts:703-773` contains focused coverage for
  generation of both direct-person and unclaimed-role-pool occurrences.
- `src/lib/restaurant/job-roles.db.test.ts:775-850` covers atomic concurrent
  claiming, retry idempotency, and denial to a staff member without the pooled
  role.
- `src/lib/restaurant/job-roles.db.test.ts:852-927` verifies that person and role
  assignment paths coexist, de-duplicate correctly, and do not leak work to an
  ineligible staff member.
- `prisma/migrations/20260828120000_restaurant_sop_job_roles_assignment/migration.sql:269-318`
  uses organization-bearing composite foreign keys for the new relationships,
  preserving tenant isolation at the database boundary.

## Archive disposition

Nothing from either archived commit is cherry-picked or reopened:

- `f8433904 feat(restaurant): SOP job roles, assignee targets and claim pools` is
  skipped because every named feature is already present, including focused
  concurrency, eligibility, de-duplication, and tenant-isolation coverage.
- `541bd083 wip: uncommitted worktree state of WHA-225 before consolidation` is
  skipped because it is a dirty worktree snapshot of the same consolidated work;
  reapplying a snapshot over the current implementation would add duplicate or
  stale code without a missing behavior to justify it.

The archive object is not available in this checkout and no `origin` remote is
configured, so a byte-for-byte archive diff cannot be reproduced locally. The
disposition above is based on the issue-provided commit list and direct
verification of each described behavior in the current tree. This limitation
does not warrant restoring the deleted branch because its stated feature scope
is already represented in production code, migration constraints, and focused
tests.
