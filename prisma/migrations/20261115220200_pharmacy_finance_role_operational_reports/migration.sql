-- DEV-519: the pharmacy Finance role template granted `reports:financial`, but
-- every pharmacy financial report sits inside the Reports command centre, whose
-- rail entry, page and procedures check `reports:operational`. The catalog
-- template now grants both; give already-provisioned pharmacy Finance system
-- roles the same `reports:operational` grant so the reports they hold open.
-- Only system roles in PHARMACY organizations are touched; tenant-authored
-- lookalikes are not widened. Idempotent. An existing row for the capability
-- (including an explicit DENY) is left untouched.
-- Wrapped in a transaction so the transaction-local set_config applies to the
-- INSERT under FORCE ROW LEVEL SECURITY on organization_roles.
BEGIN;

SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO "organization_role_permissions"
  ("id", "organizationId", "organizationRoleId", "capability", "effect", "createdAt")
SELECT
  'ph_fin_ops_' || md5(role.id || ':reports:operational'),
  role."organizationId",
  role.id,
  'reports:operational',
  'ALLOW'::"PermissionEffect",
  CURRENT_TIMESTAMP
FROM "organization_roles" role
JOIN "organizations" organization ON organization.id = role."organizationId"
WHERE organization.vertical = 'PHARMACY'
  AND role."isSystem" = true
  AND role.key = 'finance'
ON CONFLICT ("organizationRoleId", "capability") DO NOTHING;

COMMIT;
