-- Shared backfill for pharmacy_branch_assignments. The table migration left the
-- set empty, which denies every non-admin cashier. Assign each active pharmacy
-- member to every active branch in their own pharmacy organization. Idempotent.
-- Restaurant organizations are not included. Later deploys, including the
-- controlled-register work, rely on this migration rather than a second backfill.
WITH elevated AS (
  SELECT set_config('app.is_platform_admin', 'true', true) AS platform_admin
)
INSERT INTO "pharmacy_branch_assignments" (
  "id",
  "organizationId",
  "branchId",
  "userId",
  "active",
  "updatedAt"
)
SELECT
  'pba_' || md5(u."organizationId" || ':' || b."id" || ':' || u."id"),
  u."organizationId",
  b."id",
  u."id",
  true,
  CURRENT_TIMESTAMP
FROM elevated
JOIN "users" u ON true
JOIN "organizations" o ON o."id" = u."organizationId"
JOIN "pharmacy_branches" b ON b."organizationId" = u."organizationId"
LEFT JOIN "organization_roles" r ON r."id" = u."organizationRoleId"
WHERE o."vertical" = 'PHARMACY'::"OrganizationVertical"
  AND b."active" = true
  AND u."status" IN ('ACTIVE'::"UserStatus", 'ON_LEAVE'::"UserStatus")
  AND (
    r."key" IN (
      'owner',
      'owner-operator',
      'pharmacist',
      'manager',
      'cashier',
      'procurement',
      'inventory',
      'finance',
      'auditor'
    )
    OR EXISTS (
      SELECT 1
      FROM "organization_role_permissions" p
      WHERE p."organizationRoleId" = u."organizationRoleId"
        AND p."effect" = 'ALLOW'::"PermissionEffect"
        AND (
          p."capability" = '*'
          OR p."capability" LIKE 'pharmacy.%'
          OR p."capability" LIKE 'pharmacy:%'
        )
    )
  )
ON CONFLICT ("organizationId", "branchId", "userId") DO NOTHING;
