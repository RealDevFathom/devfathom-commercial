# `archive/wip/WHA-225-dirty` disposition

**Issue:** #503

**Archived tip:** `541bd083`

**Feature commit:** `f8433904` (`feat(restaurant): SOP job roles, assignee targets and claim pools`)

**Decision:** **Close the archived branch as obsolete. Do not recreate it and do not
cherry-pick either archived commit.**

## Evaluation

The archive contains a feature commit followed by a worktree-snapshot commit. The
feature's durable behavior is already present on `develop`, while the snapshot is
not an independently reviewed change set. Replaying either commit would therefore
duplicate migrations and domain code, or reintroduce stale worktree state over the
newer implementation.

The current implementation covers the archived feature areas:

- `prisma/migrations/20260828120000_restaurant_sop_job_roles_assignment/migration.sql`
  creates branch-scoped, many-to-many restaurant job roles, role capabilities,
  staff-role audit history, `PERSON | ROLE` SOP targets, and occurrence claim-pool
  fields. It also backfills existing assignments before enabling the target
  constraint.
- `src/lib/restaurant/job-roles.ts` is the current job-role domain implementation.
  It unions capabilities across all active roles held by a staff profile and keeps
  membership changes auditable.
- `src/lib/restaurant/sop-assignment.ts` resolves person and role targets, expands
  role targets into pools, and claims occurrences with an atomic conditional
  update.
- `src/server/routers/restaurant-sop.ts` exposes the supported assignment and claim
  operations through the capability-gated restaurant API.

The current tests are stronger than the archived branch's recovery value:

- `src/lib/restaurant/job-roles.db.test.ts` exercises many-to-many role holdings,
  capability unions, target integrity, pool eligibility, concurrent first-claimer
  wins, retry idempotency, and unauthorized claims against PostgreSQL.
- `src/server/routers/restaurant-sop.test.ts` covers target resolution at the API
  boundary.
- `src/lib/restaurant/job-role-profiles.test.ts` protects the seeded profiles and
  the privilege ladder.

## Owner compatibility

No role or capability is removed by this disposition. In particular, the separate
back-office restaurant `owner` role remains the wildcard all-capability role, and
the floor job-role `owner` remains the top of the enumerated capability ladder.
Enumerating floor capabilities is intentional: it permits a per-person deny to
subtract a named capability without weakening the solo-owner back-office role.

## Resolution

The relevant WHA-225 work has already reached `develop` in its maintained form.
Issue #503 should be closed with this recorded disposition; the archive tag remains
historical evidence only.
