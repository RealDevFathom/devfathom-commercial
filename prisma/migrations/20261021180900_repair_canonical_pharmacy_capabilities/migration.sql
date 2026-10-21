-- Repair canonical pharmacy grants for databases where transaction-local RLS scope was lost.
-- Collision handling is deliberately deny-biased so this replay can never widen access.
BEGIN;
SELECT set_config('app.is_platform_admin', 'true', true);

UPDATE "organization_role_permissions" canonical
SET "effect" = 'DENY'
FROM "organization_role_permissions" legacy
WHERE legacy."organizationRoleId" = canonical."organizationRoleId"
  AND legacy."capability" LIKE 'pharmacy.%'
  AND canonical."capability" = 'pharmacy:' || substr(legacy."capability", 10)
  AND legacy."effect" = 'DENY'
  AND canonical."effect" <> 'DENY';

DELETE FROM "organization_role_permissions" legacy
USING "organization_role_permissions" canonical
WHERE legacy."organizationRoleId" = canonical."organizationRoleId"
  AND legacy."capability" LIKE 'pharmacy.%'
  AND canonical."capability" = 'pharmacy:' || substr(legacy."capability", 10);

UPDATE "organization_role_permissions"
SET "capability" = 'pharmacy:' || substr("capability", 10)
WHERE "capability" LIKE 'pharmacy.%';

UPDATE "user_permission_overrides" canonical
SET "effect" = 'DENY'
FROM "user_permission_overrides" legacy
WHERE legacy."userId" = canonical."userId"
  AND legacy."capability" LIKE 'pharmacy.%'
  AND canonical."capability" = 'pharmacy:' || substr(legacy."capability", 10)
  AND legacy."effect" = 'DENY'
  AND canonical."effect" <> 'DENY';

DELETE FROM "user_permission_overrides" legacy
USING "user_permission_overrides" canonical
WHERE legacy."userId" = canonical."userId"
  AND legacy."capability" LIKE 'pharmacy.%'
  AND canonical."capability" = 'pharmacy:' || substr(legacy."capability", 10);

UPDATE "user_permission_overrides"
SET "capability" = 'pharmacy:' || substr("capability", 10)
WHERE "capability" LIKE 'pharmacy.%';

COMMIT;
