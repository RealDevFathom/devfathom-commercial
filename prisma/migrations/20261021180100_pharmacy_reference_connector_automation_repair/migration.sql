-- Repair pharmacy role grants that could have been skipped when Prisma applied
-- their original migrations statement-by-statement.  FORCE RLS requires the
-- platform flag and the writes to share one transaction.
BEGIN;
SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO "organization_role_permissions"
  ("id", "organizationId", "organizationRoleId", "capability", "effect", "createdAt")
SELECT
  'pharmacy_grant_' || md5(role.id || ':' || grant.capability),
  role."organizationId",
  role.id,
  grant.capability,
  'ALLOW'::"PermissionEffect",
  CURRENT_TIMESTAMP
FROM "organization_roles" role
JOIN "organizations" organization ON organization.id = role."organizationId"
CROSS JOIN LATERAL (
  SELECT capability
  FROM (VALUES
    ('owner', 'pharmacy:*'),
    ('owner', 'reports:operational'),
    ('owner', 'reports:financial'),
    ('owner-operator', 'reports:operational'),
    ('owner-operator', 'reports:financial'),
    ('owner-operator', 'pharmacy:orders'),
    ('owner-operator', 'pharmacy:dispense'),
    ('owner-operator', 'pharmacy:catalogue-review'),
    ('owner-operator', 'pharmacy:safety'),
    ('pharmacist', 'pharmacy:dispense'),
    ('pharmacist', 'pharmacy:catalogue-review'),
    ('manager', 'pharmacy:manage'),
    ('manager', 'pharmacy:orders'),
    ('cashier', 'pharmacy:counter'),
    ('cashier', 'pharmacy:orders'),
    ('procurement', 'pharmacy:procurement'),
    ('inventory', 'pharmacy:inventory'),
    ('finance', 'reports:financial'),
    ('auditor', 'reports:operational')
  ) AS canonical(role_key, capability)
  WHERE canonical.role_key = role.key
) grant
WHERE organization.vertical = 'PHARMACY'::"OrganizationVertical"
  AND role."isSystem" = true
-- Existing ALLOW or DENY rows are operator decisions and must win.
ON CONFLICT ("organizationRoleId", capability) DO NOTHING;

COMMIT;
