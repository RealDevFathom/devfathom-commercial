-- Bring installed system Pharmacist roles up to the new-shop day-close grant.
-- Preserve every explicit grant or denial.
BEGIN;
SET LOCAL lock_timeout = '10s';

SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO organization_role_permissions
  (id, "organizationId", "organizationRoleId", capability, effect, "createdAt")
SELECT 'ph_close_' || md5(role.id || ':pharmacy:close'),
       org.id, role.id, 'pharmacy:close', 'ALLOW'::"PermissionEffect", CURRENT_TIMESTAMP
FROM organization_roles role
JOIN organizations org ON org.id = role."organizationId"
WHERE org.vertical = 'PHARMACY'
  AND role."isSystem"
  AND role.key = 'pharmacist'
ON CONFLICT ("organizationRoleId", capability) DO NOTHING;

COMMIT;
