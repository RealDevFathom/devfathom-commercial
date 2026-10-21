-- Normalize only known legacy pharmacy grants. Unknown/malformed grants remain inert.
-- Transaction-local platform context traverses tenants without disabling FORCE RLS.
BEGIN;
SELECT set_config('app.is_platform_admin', 'true', true);
CREATE TEMP TABLE pharmacy_capability_aliases (legacy text, canonical text) ON COMMIT DROP;
INSERT INTO pharmacy_capability_aliases VALUES
('pharmacy.*','pharmacy:*'),('pharmacy.*','reports:operational'),('pharmacy.*','reports:financial'),('pharmacy.dispense','pharmacy:dispense'),('pharmacy.dispense','pharmacy:safety'),('pharmacy.manage','pharmacy:manage'),('pharmacy.counter','pharmacy:counter'),('pharmacy.procurement','pharmacy:procurement'),('pharmacy.inventory','pharmacy:inventory'),('pharmacy.finance','reports:financial'),('pharmacy.audit','reports:operational');
DO $$ DECLARE a record; BEGIN
FOR a IN SELECT * FROM pharmacy_capability_aliases ORDER BY legacy, canonical LOOP
INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect,"createdAt")
SELECT 'qa130_' || md5(p.id || a.canonical), p."organizationId",p."organizationRoleId",a.canonical,p.effect,p."createdAt"
FROM organization_role_permissions p WHERE p.capability=a.legacy
ON CONFLICT ("organizationRoleId",capability) DO UPDATE SET effect =
 CASE WHEN organization_role_permissions.effect='DENY' OR EXCLUDED.effect='DENY'
 THEN 'DENY'::"PermissionEffect" ELSE 'ALLOW'::"PermissionEffect" END;

END LOOP;
-- User overrides rename one grant only; template additions must not fan out here.
FOR a IN SELECT * FROM (VALUES
 ('pharmacy.*','pharmacy:*'),
 ('pharmacy.dispense','pharmacy:dispense'),
 ('pharmacy.manage','pharmacy:manage'),
 ('pharmacy.counter','pharmacy:counter'),
 ('pharmacy.procurement','pharmacy:procurement'),
 ('pharmacy.inventory','pharmacy:inventory'),
 ('pharmacy.finance','reports:financial'),
 ('pharmacy.audit','reports:operational')
) AS aliases(legacy, canonical) LOOP
INSERT INTO user_permission_overrides (id,"organizationId","userId",capability,effect,reason,"expiresAt","createdById","createdAt","updatedAt")
SELECT 'qa130_' || md5(p.id || a.canonical),p."organizationId",p."userId",a.canonical,p.effect,p.reason,p."expiresAt",p."createdById",p."createdAt",p."updatedAt"
FROM user_permission_overrides p WHERE p.capability=a.legacy
ON CONFLICT ("userId",capability) DO UPDATE SET
 -- Keep the winning row's expiry and metadata. Existing DENY wins ties;
 -- a legacy DENY replaces canonical ALLOW without becoming permanent.
 effect = EXCLUDED.effect,
 reason = EXCLUDED.reason,
 "expiresAt" = EXCLUDED."expiresAt",
 "createdById" = EXCLUDED."createdById",
 "createdAt" = EXCLUDED."createdAt",
 "updatedAt" = EXCLUDED."updatedAt"
 WHERE user_permission_overrides.effect <> 'DENY'
   AND EXCLUDED.effect = 'DENY';
END LOOP;
END $$;
DELETE FROM organization_role_permissions WHERE capability IN (SELECT legacy FROM pharmacy_capability_aliases);
DELETE FROM user_permission_overrides WHERE capability IN (SELECT legacy FROM pharmacy_capability_aliases);
COMMIT;
