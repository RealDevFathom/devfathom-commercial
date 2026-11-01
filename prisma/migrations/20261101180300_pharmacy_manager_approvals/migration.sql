BEGIN;
-- System managers approve non-clinical counter and inventory work. Do not widen
-- custom roles, other verticals, or replace an existing capability DENY.
SELECT set_config('app.is_platform_admin', 'true', true);
INSERT INTO organization_role_permissions
  (id, "organizationId", "organizationRoleId", capability, effect)
SELECT 'manager_approval_' || md5(r.id || ':' || c.capability),
  r."organizationId", r.id, c.capability, 'ALLOW'::"PermissionEffect"
FROM organization_roles r
JOIN organizations o ON o.id = r."organizationId"
CROSS JOIN (VALUES ('pharmacy:counter'), ('pharmacy:inventory')) c(capability)
WHERE o.vertical = 'PHARMACY' AND r.key = 'manager' AND r."isSystem" = true
ON CONFLICT ("organizationRoleId", capability) DO NOTHING;
COMMIT;
