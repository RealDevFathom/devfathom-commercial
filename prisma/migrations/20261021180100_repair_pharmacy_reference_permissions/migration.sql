-- Replay data changes from 20260905070000_pharmacy_reference_connector_automation (#218).
-- Explicit transaction keeps platform scope alive across statements.
-- Original migrations remain immutable; predicates/conflict handling permit replay.
BEGIN;
SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO "organization_role_permissions"
  ("id", "organizationId", "organizationRoleId", "capability", "effect", "createdAt")
SELECT
  'wha1339_' || md5(role.id || ':pharmacy:catalogue-review'),
  role."organizationId",
  role.id,
  'pharmacy:catalogue-review',
  'ALLOW',
  CURRENT_TIMESTAMP
FROM "organization_roles" role
JOIN "organizations" organization ON organization.id = role."organizationId"
WHERE organization.vertical = 'PHARMACY' AND role.key = 'pharmacist'
ON CONFLICT ("organizationRoleId", "capability") DO NOTHING;

COMMIT;
