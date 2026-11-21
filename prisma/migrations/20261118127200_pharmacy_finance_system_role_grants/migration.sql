-- DEV-969. Apply the two built-in pharmacy role templates to existing tenants.
-- Keep explicit refusals and all custom roles, including same-name roles.
BEGIN;
SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO organization_role_permissions
  (id, "organizationId", "organizationRoleId", capability, effect, "createdAt")
SELECT 'ph_fin_' || md5(role.id || ':' || grant_row.capability),
       role."organizationId", role.id, grant_row.capability, 'ALLOW'::"PermissionEffect", now()
FROM organization_roles AS role
JOIN organizations AS org ON org.id = role."organizationId"
CROSS JOIN (VALUES ('finance:read'), ('finance:manage')) AS grant_row(capability)
WHERE org.vertical = 'PHARMACY' AND role."isSystem" AND role.key IN ('finance', 'owner-operator')
ON CONFLICT ("organizationRoleId", capability) DO NOTHING;

COMMIT;
