# Pharmacy day close: managers and owners only (rollout)

Decision: day close (`closePreview`, `closeDay`, `dailyClose`) is for owners,
administrators and managers. Pharmacists and cashiers do not close the day by default.
Source: Saad on DEV-32 (2026-11-01), reaffirmed on DEV-739. Whether a tenant may still
grant close to a pharmacist through a custom role or user override is **not decided**;
nothing here changes that.

## Why two phases

The migration job runs and finishes before the new web revision serves. The close gate
on develop before DEV-739 (`requireCloseAccess(ctx)`) checks only `ADMIN` or
`pharmacy:close`. It does not check the branch assignment. If existing Manager roles
received `pharmacy:close` in the same deploy, then from the migration until the new
revision serves everywhere, a manager could preview, close or re-cut any active branch
of their organization. Phase 1 grants nothing, so that window cannot occur.

| Phase | Ships | Effect while the previous revision still serves |
| --- | --- | --- |
| 1: DEV-739 (#1413) | New close gate (deny-wins for ADMIN too; non-admins need an active assignment to the branch). Templates: Pharmacist without `pharmacy:close`, Manager with it. Migration `20261104120000_pharmacy_pharmacist_day_close_revoke`: removes the template ALLOW from system Pharmacist roles. | Only removes access. |
| 2: follow-up, after phase 1 serves everywhere | One migration: the SQL below. | Not applicable: the new gate is live. |

Existing Manager roles cannot close on develop today either, so phase 1 takes nothing
away from them. Managers in organizations provisioned after phase 1 get close from the
template immediately, behind the new gate.

## Phase 1 deploy

1. Do not provision pharmacy organizations during the deploy. A previous revision that
   provisions one after the migration still creates a Pharmacist with the old
   `pharmacy:close` ALLOW. Phase 2 re-runs the revoke to catch any it missed.
2. Deploy normally: the migration job, then the web revision.
3. After every replica serves the new image, run the read-only checks below. Expect
   check A = 0. Check B may be greater than 0 until phase 2.

## Phase 2 migration (follow-up PR, only after phase 1 is verified)

```sql
BEGIN;
SELECT set_config('app.is_platform_admin', 'true', true);

-- Re-run phase 1's revoke (idempotent): catches Pharmacist roles a previous revision
-- provisioned during the phase 1 deploy.
DELETE FROM organization_role_permissions p
USING organization_roles r, organizations o
WHERE p."organizationRoleId" = r.id
  AND p."organizationId" = r."organizationId"
  AND o.id = r."organizationId"
  AND o.vertical = 'PHARMACY'
  AND r.key = 'pharmacist'
  AND r."isSystem" = true
  AND p.capability = 'pharmacy:close'
  AND p.effect = 'ALLOW'::"PermissionEffect";

-- Existing system Managers receive the grant the template already carries. An
-- existing row, including an explicit DENY, is left as it is.
INSERT INTO organization_role_permissions
  (id, "organizationId", "organizationRoleId", capability, effect, "createdAt")
SELECT 'dev739_' || md5(r.id || ':pharmacy:close'), r."organizationId", r.id,
       'pharmacy:close', 'ALLOW'::"PermissionEffect", now()
FROM organization_roles r
JOIN organizations o ON o.id = r."organizationId"
WHERE o.vertical = 'PHARMACY' AND r.key = 'manager' AND r."isSystem" = true
ON CONFLICT ("organizationRoleId", capability) DO NOTHING;

COMMIT;
```

Keep the explicit `BEGIN`/`COMMIT`. Without it, the transaction-local `set_config` does
not reach the statements, forced RLS matches no rows, and the migration reports success
having done nothing (#975).

## Read-only checks (run as a platform administrator, after each phase)

```sql
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
```

If check A is not 0 after a phase, re-run that phase's migration body. It is idempotent.

## Not covered here

- Cash drawer procedures (`drawerStatus`, `openDrawer`, `drawerMovement`, `closeDrawer`)
  are unchanged; their policy belongs to DEV-279 / DEV-659 (#1086).
- Whether a tenant-authored role, a user ALLOW override, `pharmacy:*` or `*` may let a
  pharmacist close is pending Saad's decision.
