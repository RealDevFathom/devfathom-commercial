# Pharmacy day close: owners, administrators and managers (rollout)

Decision (Saad: DEV-32 2026-11-01, DEV-739 2026-11-04):

- **Who closes:** daily finalization (`closePreview`, `closeDay`, `dailyClose`) belongs to
  owners, administrators and managers.
- **Assigned role decides eligibility.** System Owner, Owner / Operator, Manager and
  Administrator roles are eligible: the system role keys `owner`, `owner-operator`,
  `manager`, `admin`, and `administrator` (the bootstrap Administrator role of
  workspaces created before the canonical templates). A tenant-made role with one of
  those keys is not a system role and is refused. A stored legacy ADMIN without an
  organization role is also eligible. Pharmacist, Cashier, other and unknown roles are refused even if a
  role or user override grants `pharmacy:close`. An Owner or Manager is eligible based
  on that assignment; their profession is not checked.
- **Capability, scope and DENYs:** eligible non-admins need `pharmacy:close` and an
  active branch assignment. A user whose stored row (not the session claim) is an active
  ADMIN has organization-wide reach. Explicit
  DENYs always win, and an assigned ineligible role blocks an ADMIN as well.
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
| 1: DEV-739 (#1413)                            | New close gate (deny-wins for ADMIN too; non-admins need an active assignment to the branch). Templates: Pharmacist without `pharmacy:close`, Manager with it. Migration `20261106220000_pharmacy_pharmacist_day_close_revoke`: removes the template ALLOW from system Pharmacist roles. | Only removes access.                            |
| 2: follow-up, after phase 1 serves everywhere | One migration: the SQL below.                                                                                                                                                                                                                                                            | Not applicable: the new gate is live.           |

Managers in organizations provisioned after phase 1 get close from the template
immediately, behind the new gate.

### Who can close between phase 1 and phase 2

Tell the affected pharmacies before phase 1, because it removes some access:

| Who                                                                                                                     | Before (develop with #654) | Between phase 1 and phase 2                                                           | After phase 2     |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------- | ----------------- |
| Stored ADMIN with no role, or with an eligible system role (Owner, Owner / Operator, Manager, `admin`, `administrator`) | Any branch                 | Any branch while their stored row is an active ADMIN, unless an explicit DENY applies | Same              |
| Stored ADMIN holding an ineligible role (Pharmacist, Cashier, custom or unknown)                                        | Any branch                 | Cannot close                                                                          | Cannot close      |
| Non-ADMIN holder of the system `admin` / `administrator` role whose role grants close                                   | Any branch                 | Only branches they are actively assigned to                                           | Same              |
| Owner, Owner / Operator (not a stored ADMIN)                                                                            | Any branch                 | Only branches they are actively assigned to                                           | Same              |
| Existing system Manager (not a stored ADMIN)                                                                            | Cannot close               | Cannot close                                                                          | Assigned branches |
| Existing system Pharmacist (provisioned since #654)                                                                     | Any branch                 | Cannot close                                                                          | Cannot close      |
| Other roles with a `pharmacy:close` grant                                                                               | Any branch                 | Cannot close                                                                          | Cannot close      |
| Cashier                                                                                                                 | Cannot close               | Cannot close                                                                          | Cannot close      |

An administrator can change their own organization role on the Organization page, so an
ineligible role on an ADMIN is not a hard control. To stop an administrator closing, a
platform operator sets a `pharmacy:close` DENY override on the user. A user whose status is
`ON_LEAVE` counts as active, as the session gate treats them.

A Pharmacist role provisioned by a previous revision may still carry an ALLOW, but the
new gate refuses it. While old replicas serve, that grant can still permit close; keep
the provisioning freeze and check A to cover the mixed-revision window. A pharmacy needs
an eligible owner or administrator until existing Managers receive their phase 2 grants.

## Phase 1 deploy

1. Freeze pharmacy organization provisioning from the start of the migration job until
   every replica serves the new image. Mixed revisions cause problems in both directions:
   - A previous revision that provisions an organization after the migration creates a
     Pharmacist with the old `pharmacy:close` ALLOW. Phase 2 re-runs the revoke to catch it.
   - A new revision that provisions an organization gives its Manager `pharmacy:close` from
     the new template. A previous revision has no branch-assignment check and could serve
     that Manager's close.
2. Before the migration job, run the read-only checks below and record P and C (the
   baseline).
3. Deploy normally: the migration job, then the web revision.
4. After every replica serves the new image, run the checks again. Expect:
   - P > 0;
   - A = 0;
   - C equal to its baseline.

   B may be greater than 0 until phase 2.

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

Phase 2 deploy:

1. Record the baseline P and C.
2. Apply the phase 2 migration.
3. Expect:
   - P > 0;
   - A = 0;
   - B = 0;
   - C equal to its baseline.

When phase 2 ships, point the database test at the new migration file, or assert that it
is byte-identical to this file. Then delete this docs copy, so the shipped SQL and the
tested SQL cannot drift apart.

## Rollback

- **Never roll the web revision back past phase 1 once phase 2 is applied.** A
  pre-DEV-739 revision's close gate has no branch-assignment check, so every Manager
  holding `pharmacy:close` could close any branch. Roll back to a phase 1 revision
  instead.
- **Rolling back phase 1 alone** (back to a pre-DEV-739 revision) is safe only if the new
  revision provisioned no pharmacy organization. Managers created from the new template
  hold `pharmacy:close` and would be served by the old gate. If any were created, remove
  that ALLOW before or together with the rollback. Before phase 2 a system Manager's
  close ALLOW can only have come from the new template, so this is valid **only before
  phase 2**:

  ```sql
  BEGIN;
  SELECT set_config('app.is_platform_admin', 'true', true);
  DELETE FROM organization_role_permissions p
  USING organization_roles r, organizations o
  WHERE p."organizationRoleId" = r.id
    AND p."organizationId" = r."organizationId"
    AND o.id = r."organizationId"
    AND o.vertical = 'PHARMACY'
    AND r.key = 'manager'
    AND r."isSystem" = true
    AND p.capability = 'pharmacy:close'
    AND p.effect = 'ALLOW'::"PermissionEffect";
  COMMIT;
  ```

- The phase 1 revoke has no rollback. Restoring a default pharmacist grant would
  contradict the decision above.

## Read-only checks (after each phase)

These tables use forced row-level security. A migration or operator role without
SUPERUSER or BYPASSRLS (the production setup) is subject to it. Run the checks exactly as written. Without the transaction-local
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

-- A. System Pharmacist roles with a close ALLOW: expect 0 after each phase.
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

-- C. Explicit DENYs are preserved: compare this count with the baseline taken before
--    the phase. Scoped to the roles the phases touch, so unrelated DENYs added
--    meanwhile do not move it.
SELECT count(*) FROM organization_role_permissions p
JOIN organization_roles r ON r.id = p."organizationRoleId"
JOIN organizations o ON o.id = r."organizationId"
WHERE o.vertical = 'PHARMACY' AND r."isSystem" AND r.key IN ('pharmacist', 'manager')
  AND p.capability = 'pharmacy:close' AND p.effect = 'DENY';

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

## Alongside the SOP rollout

The SOP rollout (DEV-751, [`pharmacy-sop-rollout.md`](pharmacy-sop-rollout.md)) records every
`pharmacy:close` count in its check D2 and expects check V4 to find them unchanged. Phase 1
lowers the Pharmacist close count and phase 2 raises the Manager count. Do not deploy
either phase between that rollout's D2 and V4. If one ran in between, retake D2 before
judging V4. A changed close count then belongs to this rollout, not to the SOP phase, and
is no reason to roll the SOP phase back.

## Not covered here

- Cash drawer procedures (`drawerStatus`, `openDrawer`, `drawerMovement`, `closeDrawer`)
  are unchanged. Their policy belongs to DEV-279 / DEV-659 (#1086).
- Pharmacy SOP checklists (DEV-751, #1418) never call or replace day close. A closing
  checklist completed by a pharmacist does not cut the day.
