-- DEV-622 (#1241, owner decision 15 Nov): add the opt-in "Pharmacist and cashier" system
-- role to every existing PHARMACY organization, so the owner can assign it to one person
-- who dispenses prescriptions and also takes payment. New organizations get it from the
-- role templates at creation.
-- The role is only created: no user is assigned to it, and no other role changes.
-- A tenant role that already uses the key (custom or system) is left untouched, and only
-- roles created here receive grants. Idempotent.
BEGIN;

SELECT set_config('app.is_platform_admin', 'true', true);

WITH created AS (
  INSERT INTO organization_roles
    (id, "organizationId", key, name, description, "isSystem", "createdAt", "updatedAt")
  SELECT
    'dev622_' || md5(o.id || ':pharmacist-cashier'),
    o.id,
    'pharmacist-cashier',
    'Pharmacist and cashier',
    'Dispenses prescriptions and takes payment, for a one-person shop or a pharmacist who also runs the till.',
    true,
    now(),
    now()
  FROM organizations o
  WHERE o.vertical = 'PHARMACY'
  ON CONFLICT ("organizationId", key) DO NOTHING
  RETURNING id, "organizationId"
)
INSERT INTO organization_role_permissions
  (id, "organizationId", "organizationRoleId", capability, effect, "createdAt")
SELECT
  'dev622_' || md5(created.id || ':' || c.capability),
  created."organizationId",
  created.id,
  c.capability,
  'ALLOW'::"PermissionEffect",
  now()
FROM created
CROSS JOIN (
  VALUES
    ('pharmacy:dispense'),
    ('pharmacy:catalogue-review'),
    ('pharmacy:close'),
    ('pharmacy:counter'),
    ('pharmacy:orders'),
    ('sop:complete'),
    ('sop:verify')
) AS c(capability)
ON CONFLICT ("organizationRoleId", capability) DO NOTHING;

COMMIT;
