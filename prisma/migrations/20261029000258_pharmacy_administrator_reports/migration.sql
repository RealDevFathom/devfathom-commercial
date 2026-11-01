-- Pharmacy workspaces created before the canonical role templates used the bootstrap
-- Administrator role. Give that system role the operational report capability used by
-- pharmacyReports.branches, catalog and getPreferences. An explicit DENY remains untouched.
SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO organization_role_permissions
  (id, "organizationId", "organizationRoleId", capability, effect, "createdAt")
SELECT
  'qa434_' || md5(r.id || ':reports:operational'),
  r."organizationId",
  r.id,
  'reports:operational',
  'ALLOW'::"PermissionEffect",
  now()
FROM organization_roles r
JOIN organizations o ON o.id = r."organizationId"
WHERE o.vertical = 'PHARMACY'
  AND r."isSystem" = true
  AND r.key IN ('admin', 'administrator')
ON CONFLICT ("organizationRoleId", capability) DO NOTHING;
