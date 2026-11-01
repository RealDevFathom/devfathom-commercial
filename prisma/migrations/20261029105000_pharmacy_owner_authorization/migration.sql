BEGIN;
-- Default pharmacy owners receive all capabilities, with explicit clinical grants.
-- Preserve all existing DENYs, including conflicts on the same capability.
SELECT set_config('app.is_platform_admin', 'true', true);
INSERT INTO organization_role_permissions (id, "organizationId", "organizationRoleId", capability, effect)
SELECT 'pop_' || md5(r.id || ':' || c.capability), r."organizationId", r.id, c.capability, 'ALLOW'
FROM organization_roles r JOIN organizations o ON o.id=r."organizationId"
CROSS JOIN (VALUES ('*'), ('pharmacy:dispense'), ('pharmacy:safety'), ('pharmacy:catalogue-review')) c(capability)
WHERE o.vertical='PHARMACY' AND r.key IN ('owner') AND r."isSystem"=true
ON CONFLICT ("organizationRoleId", capability) DO NOTHING;


COMMIT;
