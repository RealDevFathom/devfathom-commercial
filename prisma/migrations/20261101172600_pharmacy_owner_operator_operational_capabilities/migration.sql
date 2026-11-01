-- #975: the pharmacy Owner / Operator system template now also grants the
-- operational actions a proprietor needs to run the shop (Goods-in, stock,
-- counter, day close and management). Existing system roles were created from
-- the earlier six-grant template, so add every missing template capability.
-- Only system roles keyed 'owner-operator' in PHARMACY organizations are
-- touched; tenant-authored lookalikes are not widened, and an existing DENY
-- (or any existing row) for a capability is left untouched. Idempotent.
BEGIN;

SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO organization_role_permissions
  (id, "organizationId", "organizationRoleId", capability, effect, "createdAt")
SELECT
  'iss975_' || md5(r.id || ':' || c.capability),
  r."organizationId",
  r.id,
  c.capability,
  'ALLOW'::"PermissionEffect",
  now()
FROM organization_roles r
JOIN organizations o ON o.id = r."organizationId"
CROSS JOIN (
  VALUES
    ('reports:operational'),
    ('reports:financial'),
    ('pharmacy:orders'),
    ('pharmacy:dispense'),
    ('pharmacy:catalogue-review'),
    ('pharmacy:safety'),
    ('pharmacy:procurement'),
    ('pharmacy:inventory'),
    ('pharmacy:counter'),
    ('pharmacy:close'),
    ('pharmacy:manage')
) AS c(capability)
WHERE o.vertical = 'PHARMACY'
  AND r.key = 'owner-operator'
  AND r."isSystem" = true
ON CONFLICT ("organizationRoleId", capability) DO NOTHING;

COMMIT;
