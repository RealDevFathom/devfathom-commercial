-- Keep already-provisioned Pharmacy Cashier system roles aligned with the
-- prescription-intake capability in the catalog. Custom roles named cashier
-- are not widened, and an existing explicit DENY remains untouched.
SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO "organization_role_permissions"
  ("id", "organizationId", "organizationRoleId", "capability", "effect", "createdAt")
SELECT
  'cashier_rx_capture_' || md5(role.id),
  role."organizationId",
  role.id,
  'pharmacy:prescriptions',
  'ALLOW'::"PermissionEffect",
  CURRENT_TIMESTAMP
FROM "organization_roles" role
JOIN "organizations" organization ON organization.id = role."organizationId"
WHERE organization.vertical = 'PHARMACY'
  AND role."isSystem" = true
  AND role.key = 'cashier'
ON CONFLICT ("organizationRoleId", "capability") DO NOTHING;
