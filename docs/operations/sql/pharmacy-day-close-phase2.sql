-- DEV-739 day-close rollout, phase 2 of 2. NOT a migration in this release.
-- Ship it as its own Prisma migration (copy this file unchanged) only after the
-- phase 1 web revision serves on every replica and the runbook checks pass:
-- docs/operations/pharmacy-day-close-rollout.md. tests/pharmacy-capabilities.db.test.ts
-- runs this file so the SQL that will ship is the SQL that was tested.
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
