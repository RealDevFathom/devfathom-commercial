-- DEV-505: the pharmacy Manager system template now grants `pharmacy:inventory`,
-- so a Manager can run stock for the branches they are assigned to (inventory
-- access stays branch-scoped on the server). Keep already-provisioned Manager
-- roles in step with the catalog template.
-- Only system `manager` roles in PHARMACY organizations are touched; tenant-authored
-- lookalikes are not widened. Idempotent. An existing row for the capability
-- (including an explicit DENY) is left untouched.
-- Wrapped in a transaction so the transaction-local set_config applies to the
-- INSERT under FORCE ROW LEVEL SECURITY on organization_roles.
BEGIN;

SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO "organization_role_permissions"
  ("id", "organizationId", "organizationRoleId", "capability", "effect", "createdAt")
SELECT
  'ph_mgr_inventory_' || md5(role.id || ':pharmacy:inventory'),
  role."organizationId",
  role.id,
  'pharmacy:inventory',
  'ALLOW'::"PermissionEffect",
  CURRENT_TIMESTAMP
FROM "organization_roles" role
JOIN "organizations" organization ON organization.id = role."organizationId"
WHERE organization.vertical = 'PHARMACY'
  AND role."isSystem" = true
  AND role.key = 'manager'
ON CONFLICT ("organizationRoleId", "capability") DO NOTHING;

COMMIT;
