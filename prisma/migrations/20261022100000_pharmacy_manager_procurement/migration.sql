-- Preserve the pre-capability purchasing and Goods-in access of the pharmacy
-- Manager system template in existing organizations. Custom roles named
-- "manager" are intentionally not widened, and an existing DENY wins.
SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO organization_role_permissions
  (id, "organizationId", "organizationRoleId", capability, effect, "createdAt")
SELECT
  'manager_procurement_' || md5(r.id),
  r."organizationId",
  r.id,
  'pharmacy:procurement',
  'ALLOW'::"PermissionEffect",
  now()
FROM organization_roles r
JOIN organizations o ON o.id = r."organizationId"
WHERE o.vertical = 'PHARMACY'
  AND r.key = 'manager'
  AND r."isSystem" = true
ON CONFLICT ("organizationRoleId", capability) DO NOTHING;
