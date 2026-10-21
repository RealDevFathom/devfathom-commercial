BEGIN;

-- Clinical capabilities no longer inherit from wildcards. Preserve the access
-- that existing roles and users held before that authorization change by adding
-- an explicit dispense grant. An existing exact rule (especially a DENY) wins.
SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO organization_role_permissions
  (id, "organizationId", "organizationRoleId", capability, effect, "createdAt")
SELECT
  'rxdisp_' || md5(p."organizationRoleId"),
  p."organizationId",
  p."organizationRoleId",
  'pharmacy:dispense',
  'ALLOW'::"PermissionEffect",
  p."createdAt"
FROM organization_role_permissions p
WHERE p.capability IN ('*', 'pharmacy:*')
  AND p.effect = 'ALLOW'
ON CONFLICT ("organizationRoleId", capability) DO NOTHING;

-- A user may have both wildcards. Prefer a permanent grant, then the grant with
-- the longest remaining lifetime, while retaining its audit metadata.
INSERT INTO user_permission_overrides
  (id, "organizationId", "userId", capability, effect, reason, "expiresAt",
   "createdById", "createdAt", "updatedAt")
SELECT DISTINCT ON (p."userId")
  'rxdisp_' || md5(p."userId"),
  p."organizationId",
  p."userId",
  'pharmacy:dispense',
  'ALLOW'::"PermissionEffect",
  p.reason,
  p."expiresAt",
  p."createdById",
  p."createdAt",
  p."updatedAt"
FROM user_permission_overrides p
WHERE p.capability IN ('*', 'pharmacy:*')
  AND p.effect = 'ALLOW'
ORDER BY p."userId", p."expiresAt" DESC NULLS FIRST, p."updatedAt" DESC
ON CONFLICT ("userId", capability) DO NOTHING;

COMMIT;
