BEGIN;

-- Normalize only the exact legacy dispense capability. Broad wildcard grants
-- must not acquire this clinical capability.
SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO organization_role_permissions
  (id, "organizationId", "organizationRoleId", capability, effect, "createdAt")
SELECT
  'rxdisp_' || md5(p.id),
  p."organizationId",
  p."organizationRoleId",
  'pharmacy:dispense',
  p.effect,
  p."createdAt"
FROM organization_role_permissions p
WHERE p.capability = 'pharmacy.dispense'
ON CONFLICT ("organizationRoleId", capability) DO UPDATE SET effect =
  CASE
    WHEN organization_role_permissions.effect = 'DENY' OR EXCLUDED.effect = 'DENY'
      THEN 'DENY'::"PermissionEffect"
    ELSE 'ALLOW'::"PermissionEffect"
  END;

INSERT INTO user_permission_overrides
  (id, "organizationId", "userId", capability, effect, reason, "expiresAt",
   "createdById", "createdAt", "updatedAt")
SELECT
  'rxdisp_' || md5(p.id),
  p."organizationId",
  p."userId",
  'pharmacy:dispense',
  p.effect,
  p.reason,
  p."expiresAt",
  p."createdById",
  p."createdAt",
  p."updatedAt"
FROM user_permission_overrides p
WHERE p.capability = 'pharmacy.dispense'
ON CONFLICT ("userId", capability) DO UPDATE SET
  effect = EXCLUDED.effect,
  reason = EXCLUDED.reason,
  "expiresAt" = EXCLUDED."expiresAt",
  "createdById" = EXCLUDED."createdById",
  "createdAt" = EXCLUDED."createdAt",
  "updatedAt" = EXCLUDED."updatedAt"
WHERE user_permission_overrides.effect <> 'DENY'
  AND EXCLUDED.effect = 'DENY';

DELETE FROM organization_role_permissions WHERE capability = 'pharmacy.dispense';
DELETE FROM user_permission_overrides WHERE capability = 'pharmacy.dispense';

COMMIT;
