-- Keep already-provisioned Restaurant system roles aligned with the catalog.
-- A conflicting permission (including an explicit DENY) remains untouched.
SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO "organization_role_permissions"
  ("id", "organizationId", "organizationRoleId", "capability", "effect", "createdAt")
SELECT
  'rest_staff_' || md5(role.id || ':staff:manage'),
  role."organizationId",
  role.id,
  'staff:manage',
  'ALLOW'::"PermissionEffect",
  CURRENT_TIMESTAMP
FROM "organization_roles" role
JOIN "organizations" organization ON organization.id = role."organizationId"
WHERE organization.vertical = 'RESTAURANT'
  AND role."isSystem" = true
  AND role.key IN ('general-manager', 'branch-manager')
ON CONFLICT ("organizationRoleId", "capability") DO NOTHING;
