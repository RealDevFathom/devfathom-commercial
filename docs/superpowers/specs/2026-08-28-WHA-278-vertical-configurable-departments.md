# WHA-278 — Vertical-configurable departments

## Status and scope

This specification records the bounded schema-lane design. Implementation is blocked pending the
two ownership/product decisions under **Open decisions**. The lane owns the Prisma department
schema and one migration, vertical-catalog department definitions, tenant department
administration/data access, and focused tests. Workspace/session authentication, demo fixtures,
unrelated migrations, and existing organization RLS policy definitions remain out of scope.

## Required behavior

- The vertical catalog is the source of default department definitions.
- Agency defaults preserve `LEADERSHIP`, `ENGINEERING`, `PRODUCT`, `QUALITY`, `MARKETING`, and
  `DESIGN` with their current display labels.
- Restaurant defaults include `KITCHEN` / “Kitchen” and `FRONT_OF_HOUSE` / “Front of House” and
  contain no agency-only defaults.
- Existing user department values survive migration exactly; no row is discarded or mapped to a
  different department.
- A tenant administrator can list, create, rename, and retire only departments in that tenant.
- A department referenced by users cannot be hard-deleted. Retiring it preserves historical and
  current user references while preventing new assignment.
- Tenant-scoped access is fail-closed under forced RLS; focused database evidence must run as a
  role that is neither `SUPERUSER` nor `BYPASSRLS`.

## Proposed data model

Add a tenant-scoped `Department` model/table with:

- `id` (cuid primary key), `organizationId`, immutable normalized `key`, editable `name`,
  `active`, `createdAt`, and `updatedAt`;
- a unique constraint on `(organizationId, key)` and `(organizationId, name)`;
- an organization relation with cascade deletion only when the whole tenant is deleted;
- forced RLS using `organizationId = current_setting('app.current_organization_id', true)` and
  the repository's existing platform-admin escape hatch.

The recommended compatibility model keeps `users.department` as the stable department key but
changes its PostgreSQL type from the global `Department` enum to `text`. A composite foreign key
`users(organizationId, department) -> departments(organizationId, key)` then prevents cross-tenant
assignment while preserving the current string-shaped API/session contract. Names are editable;
keys are immutable. Hard deletion is rejected while referenced, and retirement is the normal
removal operation.

The alternative is a `departmentId` foreign key. That is a larger breaking change across auth,
SCIM, AI tools, team APIs, platform administration, seeds, and UI contracts and therefore is not
safe to infer inside this schema lane.

## Migration and backfill

The forward migration must be atomic and fail closed:

1. Create `departments`, indexes, forced RLS, and tenant policy.
2. Insert the catalog defaults for each organization according to `organizations.vertical`.
3. Insert any distinct legacy `(organizationId, users.department)` value not already present,
   using a title-cased label. This preserves agency values even if a tenant vertical was corrected
   previously and preserves all unexpected but valid legacy values.
4. Convert `users.department` from the PostgreSQL enum to `text` with an explicit
   `USING department::text` expression.
5. Add the composite foreign key only after an anti-join proves there are no orphaned values.
6. Drop the old PostgreSQL enum only after no column depends on it.

Migration tests must cover both vertical default sets, a complete legacy agency value set,
unexpected legacy values, no user-row loss, and no orphan after the constraint is installed.

New-organization provisioning must create catalog defaults in the same owning transaction as the
organization and initial administrator. The initial administrator's department must be selected
from that vertical's defaults (agency `LEADERSHIP`; a separately approved restaurant key), so a
failed default insert or user insert rolls back the entire organization creation.

## Administration and isolation

Add tenant-admin procedures to list departments, create a normalized unique key/name, rename a
display name, and retire an active department. Every lookup and mutation must include the current
session organization ID even though tenant RLS also applies. Creation/rename conflicts return the
existing conflict error contract. Retiring a department is allowed with current users; assigning
an inactive or foreign-tenant department is rejected before writing.

Focused tests must prove admin happy paths, non-admin denial, duplicate rejection, inactive-value
assignment rejection, and tenant A being unable to read or mutate tenant B. The database isolation
test must explicitly query `pg_roles` and assert the runtime role has both `rolsuper = false` and
`rolbypassrls = false`.

## Compatibility and rollback

Keeping the stable key in `users.department` preserves current serialized values and permits UI
consumers to adopt catalog labels incrementally. Existing enum imports and `z.enum(...)` validators
must be replaced in the owned administration/data-access surfaces; auth/session behavior remains
unchanged in this lane.

Rollback is code-first and expand/contract: stop department edits, remove the composite foreign
key, and retain the table/data. Recreating the old enum is safe only after proving every stored key
is one of the six legacy agency values. Restaurant/custom keys make enum rollback lossy, so the
migration must not provide an unconditional destructive down migration. Recovery uses a database
snapshot or a later forward migration after explicit value mapping approval.

## Open decisions (blocking)

1. Approve the compatibility model: stable string key plus composite tenant foreign key, or assign
   the broader cross-lane work needed for `departmentId`.
2. Assign/approve the out-of-lane onboarding edit in `src/lib/platform/commands.ts`, including the
   restaurant initial administrator department (`KITCHEN`, `FRONT_OF_HOUSE`, or a third catalog
   default such as `MANAGEMENT`). Without this, new restaurant organizations cannot be created
   atomically with valid vertical defaults and an initial administrator.

