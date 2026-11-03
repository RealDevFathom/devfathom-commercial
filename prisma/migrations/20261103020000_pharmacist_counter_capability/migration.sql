-- DEV-622: pharmacists need the canonical counter grant to tender the
-- prescriptions they dispense. New organizations receive this grant from
-- PHARMACY_ROLE_TEMPLATES; widen existing system Pharmacist roles as well.
-- Tenant-authored roles are untouched, and an explicit DENY is preserved.
BEGIN;

SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO organization_role_permissions
  (id, "organizationId", "organizationRoleId", capability, effect, "createdAt")
SELECT
  'dev622_' || md5(r.id || ':pharmacy:counter'),
  r."organizationId",
  r.id,
  'pharmacy:counter',
  'ALLOW'::"PermissionEffect",
  now()
FROM organization_roles r
JOIN organizations o ON o.id = r."organizationId"
WHERE o.vertical = 'PHARMACY'
  AND r.key = 'pharmacist'
  AND r."isSystem" = true
ON CONFLICT ("organizationRoleId", capability) DO NOTHING;

COMMIT;
