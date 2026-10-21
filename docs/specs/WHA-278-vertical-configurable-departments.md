# WHA-278 — Vertical-configurable departments

## Data model

`organization_departments` owns an organization's editable department set. Its stable uppercase
`key` remains the value stored in `users.department`, preserving the existing string-facing auth,
API, audit, and reporting contracts. `(organizationId, key)` is unique and is the composite foreign
key target for users. Names, active state, and sort order are tenant-editable; keys are immutable.

The vertical catalog supplies Agency defaults (the six legacy enum values) and Restaurant defaults
(`KITCHEN` / Kitchen and `FRONT_OF_HOUSE` / Front of House). Restaurant defaults do not inherit
Agency values.

## Compatibility and migration/backfill

The migration creates and seeds each organization's vertical defaults, then inserts every distinct
legacy user department before converting `users.department` from the PostgreSQL enum to text. It
adds the tenant-composite foreign key only after backfill, so no existing value is discarded or
rewritten. Existing consumers continue receiving the same department string.

New and updated members must reference an active department in the caller's tenant. Tenant admins
may list, add, rename, reorder, activate/deactivate, and remove unused departments. In-use rows must
be reassigned before removal. Tenant scoping is enforced both by scoped application data access and
forced RLS on the new table.

## Provisioning new organizations

The migration backfills organizations that existed when it ran. Because `users.department` is a
composite foreign key onto `organization_departments`, an organization with an empty catalog cannot
hold a single user — so provisioning must seed the catalog before it creates the administrator.
`bootstrapOrganization` therefore writes `defaultDepartmentRowsForVertical(vertical)` immediately
after the organization row and files the bootstrap administrator under
`adminDepartmentKeyForVertical(vertical)`: `LEADERSHIP` for Agency, `FRONT_OF_HOUSE` for Restaurant.
The previously hardcoded `'LEADERSHIP'` is not a valid key in a Restaurant tenant.

Any other path that creates a user must likewise supply a key the tenant has configured.
`team.inviteMember`, the organization-admin member update, and the assistant's `inviteMember` /
`updateMember` tools all validate against the caller's active catalog and reject an unknown key with
a stated message rather than surfacing a raw constraint violation.

### Known gaps (out of this lane)

These user-creation paths still hardcode Agency-era keys and will violate the composite foreign key
in a Restaurant tenant, or in any tenant that has removed the key. They are outside this lane's
owned scope (session/SSO auth and demo seeds) and are handed off rather than changed here:

- `src/lib/sso.ts` — JIT provisioning uses `role === 'ADMIN' ? 'LEADERSHIP' : 'ENGINEERING'`.
- `src/app/api/scim/v2/Users/route.ts` — SCIM user creation, same hardcoded pair.
- `prisma/seed.ts`, `prisma/production-bootstrap.ts`, `prisma/create-admin.ts`,
  `scripts/seed-restaurant-e2e.ts` — seed users with literal Agency keys and create no catalog rows.
- `scripts/verify-tenant-isolation.ts` — inserts a `'LEADERSHIP'` user into a freshly created
  organization, so the tenant-isolation battery needs a catalog seed for its fixture organization.

## Rollback

Application rollback is compatible while all user values remain among the original six Agency enum
members. A database rollback after tenants create new keys is destructive and must fail closed:
identify/reassign non-legacy user values first, drop the composite foreign key, cast the column back
to `Department`, then drop the catalog table. Automated destructive rollback is intentionally not
provided.
