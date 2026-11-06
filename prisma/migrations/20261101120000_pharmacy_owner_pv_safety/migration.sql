-- #479: pharmacovigilance filing and review now require an exact pharmacy:safety grant,
-- which `*` and `pharmacy:*` never reach. Give the canonical pharmacy Owner role and the
-- bootstrap Administrator role (where a new pharmacy's only user sits) that one exact
-- grant so a solo pharmacy keeps PV access. Dispense and catalogue review are NOT added.
-- Only system roles in PHARMACY tenants are touched: a tenant-authored role that reuses
-- one of these keys is not widened. ON CONFLICT leaves an existing row, including an
-- explicit DENY, untouched. Forward-only and idempotent.
BEGIN;
SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO organization_role_permissions
  (id, "organizationId", "organizationRoleId", capability, effect, "createdAt")
SELECT
  'pv479_' || md5(r.id || ':pharmacy:safety'),
  r."organizationId",
  r.id,
  'pharmacy:safety',
  'ALLOW'::"PermissionEffect",
  now()
FROM organization_roles r
JOIN organizations o ON o.id = r."organizationId"
WHERE o.vertical = 'PHARMACY'
  AND r."isSystem" = true
  AND r.key IN ('owner', 'admin', 'administrator')
ON CONFLICT ("organizationRoleId", capability) DO NOTHING;

COMMIT;
