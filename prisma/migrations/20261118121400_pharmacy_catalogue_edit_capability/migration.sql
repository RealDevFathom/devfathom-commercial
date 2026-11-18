-- DEV-19: submitting catalogue edits is its own capability,
-- `pharmacy:catalogue-edit` (deny by default). Keep already-provisioned pharmacy
-- Owner / Operator system roles able to submit edits, exactly as the catalog
-- template now grants. Owner roles hold it through `pharmacy:*`; tenant
-- administrators without an organization role hold it through the static ABAC
-- policy. Only system roles in PHARMACY organizations are touched; tenant-authored
-- lookalikes are not widened. Idempotent. An existing row for the capability
-- (including an explicit DENY) is left untouched.
-- Wrapped in a transaction so the transaction-local set_config applies to the
-- INSERT under FORCE ROW LEVEL SECURITY on organization_roles.
BEGIN;

SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO "organization_role_permissions"
  ("id", "organizationId", "organizationRoleId", "capability", "effect", "createdAt")
SELECT
  'ph_cat_edit_' || md5(role.id || ':pharmacy:catalogue-edit'),
  role."organizationId",
  role.id,
  'pharmacy:catalogue-edit',
  'ALLOW'::"PermissionEffect",
  CURRENT_TIMESTAMP
FROM "organization_roles" role
JOIN "organizations" organization ON organization.id = role."organizationId"
WHERE organization.vertical = 'PHARMACY'
  AND role."isSystem" = true
  AND role.key = 'owner-operator'
ON CONFLICT ("organizationRoleId", "capability") DO NOTHING;

COMMIT;
