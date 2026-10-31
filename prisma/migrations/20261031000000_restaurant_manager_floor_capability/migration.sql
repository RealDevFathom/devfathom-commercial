BEGIN;

-- Align already-provisioned Restaurant system roles with the role catalog.
-- Preserve existing permissions, including an explicit DENY.
SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO "organization_role_permissions"
  ("id", "organizationId", "organizationRoleId", "capability", "effect", "createdAt")
SELECT
  'rest_floor_' || md5(role.id || ':floor:manage'),
  role."organizationId",
  role.id,
  'floor:manage',
  'ALLOW'::"PermissionEffect",
  CURRENT_TIMESTAMP
FROM "organization_roles" role
JOIN "organizations" organization ON organization.id = role."organizationId"
WHERE organization.vertical = 'RESTAURANT'
  AND role."isSystem" = true
  AND role.key IN ('general-manager', 'branch-manager')
ON CONFLICT ("organizationRoleId", "capability") DO NOTHING;

COMMIT;
