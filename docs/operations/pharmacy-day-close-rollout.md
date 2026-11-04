# Pharmacy day close: owners, administrators and managers (rollout)

Decision (Saad: DEV-32 2026-11-01, DEV-739 2026-11-04):

- **Who closes:** daily finalization (`closePreview`, `closeDay`, `dailyClose`) belongs to
  owners, administrators and managers.
- **No default grant for pharmacists or cashiers.** The Pharmacist and Cashier templates
  do not carry `pharmacy:close`.
- **The capability decides, not the person's profession.** A pharmacist whom the tenant
  has given the Manager role, or any role or override that grants `pharmacy:close`,
  closes with that authority, on the branches they are assigned to.
- **Admins and DENYs:** a session administrator closes organization-wide while their
  stored user row is an active ADMIN. An explicit DENY always wins.
- **Own drawer counts are separate.** Counting and closing one's own cash drawer
  (`closeDrawer`) is not day close. Its policy belongs to DEV-279 / DEV-659 (#1086) and is
  unchanged here.

## Why two phases

The migration job runs and finishes before the new web revision serves. The close gate
on develop before DEV-739 (`requireCloseAccess(ctx)`) checks only `ADMIN` or
`pharmacy:close`. It does not check the branch assignment. If existing Manager roles
received `pharmacy:close` in the same deploy, then from the migration until the new
revision serves everywhere, a manager could preview, close or re-cut any active branch
of their organization. Phase 1 grants nothing, so that window cannot occur.

| Phase                                         | Ships                                                                                                                                                                                                                                                                                    | Effect while the previous revision still serves |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1: DEV-739 (#1413)                            | New close gate (deny-wins for ADMIN too; non-admins need an active assignment to the branch). Templates: Pharmacist without `pharmacy:close`, Manager with it. Migration `20261104120000_pharmacy_pharmacist_day_close_revoke`: removes the template ALLOW from system Pharmacist roles. | Only removes access.                            |
| 2: follow-up, after phase 1 serves everywhere | One migration: the SQL below.                                                                                                                                                                                                                                                            | Not applicable: the new gate is live.           |

Managers in organizations provisioned after phase 1 get close from the template
immediately, behind the new gate.

### Who can close between phase 1 and phase 2

Tell the affected pharmacies before phase 1, because it removes some access:

| Who                                                                                                            | Before (develop with #654) | Between phase 1 and phase 2                                                           | After phase 2     |
| -------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------- | ----------------- |
| Session ADMIN (tenant administrator)                                                                           | Any branch                 | Any branch while their stored row is an active ADMIN, unless an explicit DENY applies | Same              |
| Owner, Owner / Operator (not session ADMIN)                                                                    | Any branch                 | Only branches they are actively assigned to                                           | Same              |
| Existing system Manager                                                                                        | Cannot close               | Cannot close                                                                          | Assigned branches |
| Existing system Pharmacist (provisioned since #654)                                                            | Any branch                 | Cannot close                                                                          | Cannot close      |
| Anyone whose role or override grants `pharmacy:close` (any profession, e.g. a pharmacist given a closing role) | Any branch                 | Only branches they are actively assigned to                                           | Same              |
| Cashier                                                                                                        | Cannot close               | Cannot close                                                                          | Cannot close      |

A pharmacy where a pharmacist closes the day today needs one of the following until
phase 2:

- a session ADMIN;
- an assigned owner;
- the tenant gives that pharmacist a custom role that grants `pharmacy:close`. Existing
  system Manager roles gain it only in phase 2.

Its managers can close after phase 2.

## Phase 1 deploy

1. Freeze pharmacy organization provisioning from the start of the migration job until
   every replica serves the new image. Mixed revisions cause problems in both directions:
   - A previous revision that provisions an organization after the migration creates a
     Pharmacist with the old `pharmacy:close` ALLOW. Phase 2 re-runs the revoke to catch it.
   - A new revision that provisions an organization gives its Manager `pharmacy:close` from
     the new template. A previous revision has no branch-assignment check and could serve
     that Manager's close.
2. Deploy normally: the migration job, then the web revision.
3. After every replica serves the new image, run the read-only checks below. Expect
   check A = 0. Check B may be greater than 0 until phase 2.

## Phase 2 migration (follow-up PR, only after phase 1 is verified)

The SQL is [`sql/pharmacy-day-close-phase2.sql`](sql/pharmacy-day-close-phase2.sql). Copy it
unchanged into the phase 2 Prisma migration. `tests/pharmacy-capabilities.db.test.ts` runs
that file. It re-runs phase 1's revoke, which catches Pharmacist roles a previous revision
provisioned during the phase 1 deploy. It also gives existing system Managers the
`pharmacy:close` ALLOW their template already carries, leaving any existing row, including
an explicit DENY, as it is.

Keep the explicit `BEGIN`/`COMMIT`. Without it, the transaction-local `set_config` does
not reach the statements, forced RLS matches no rows, and the migration reports success
having done nothing (#975).

## Read-only checks (after each phase)

These tables use forced row-level security, and the database administrator cannot bypass
it. Run the checks exactly as written. Without the transaction-local
`app.is_platform_admin` setting every count reads 0, a false pass (#975). Check P is the
positive control: if P is 0, the checks saw no rows and prove nothing.

```sql
BEGIN READ ONLY;
SELECT set_config('app.is_platform_admin', 'true', true);

-- P. Positive control: system Pharmacist and Manager roles in PHARMACY organizations.
--    Must be greater than 0, or the checks below are not seeing the data.
SELECT count(*) FROM organization_roles r
JOIN organizations o ON o.id = r."organizationId"
WHERE o.vertical = 'PHARMACY' AND r."isSystem" AND r.key IN ('pharmacist', 'manager');

-- A. System Pharmacists that can still close: expect 0 after phase 1 and after phase 2.
SELECT count(*) FROM organization_role_permissions p
JOIN organization_roles r ON r.id = p."organizationRoleId"
JOIN organizations o ON o.id = r."organizationId"
WHERE o.vertical = 'PHARMACY' AND r.key = 'pharmacist' AND r."isSystem"
  AND p.capability = 'pharmacy:close' AND p.effect = 'ALLOW';

-- B. System Managers with no close row at all: expect 0 after phase 2 (> 0 is normal
--    between phases). A Manager with an explicit DENY is not counted.
SELECT count(*) FROM organization_roles r
JOIN organizations o ON o.id = r."organizationId"
WHERE o.vertical = 'PHARMACY' AND r.key = 'manager' AND r."isSystem"
  AND NOT EXISTS (SELECT 1 FROM organization_role_permissions p
                  WHERE p."organizationRoleId" = r.id AND p.capability = 'pharmacy:close');

-- C. Explicit DENYs are preserved: compare this count before and after each phase.
SELECT count(*) FROM organization_role_permissions
WHERE capability = 'pharmacy:close' AND effect = 'DENY';

ROLLBACK;
```

If check A is not 0 after a phase, re-run that phase's migration body. It is idempotent.

## Phase 2 tracking

Phase 2 ships as its own migration, copied from `sql/pharmacy-day-close-phase2.sql`. Its
behaviour is already covered by `tests/pharmacy-capabilities.db.test.ts`:

- a late-provisioned Pharmacist ALLOW is removed;
- a system Manager gains the ALLOW;
- a Manager DENY is kept;
- tenant-authored and RESTAURANT managers are untouched;
- a re-run is a no-op;
- the real `can()` lets an installed Manager close.

DEV-739 tracks it until it ships.

## Not covered here

- Cash drawer procedures (`drawerStatus`, `openDrawer`, `drawerMovement`, `closeDrawer`)
  are unchanged. Their policy belongs to DEV-279 / DEV-659 (#1086).
- Pharmacy SOP checklists (DEV-751, #1418) never call or replace day close. A closing
  checklist completed by a pharmacist does not cut the day.
