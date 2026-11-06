-- #479 follow-up: pharmacovigilance endpoints require an active pharmacy branch
-- assignment. New pharmacies assign their bootstrap user to MAIN at provisioning, but an
-- existing pharmacy Owner with no assignment (or created after the 20261021133000
-- backfill, or predating a later branch) would lose PV access. Give every ACTIVE or
-- ON_LEAVE user on a built-in Owner role (isSystem, key 'owner' or 'owner-operator') in a
-- PHARMACY tenant an assignment to every active branch of their own organization.
--
-- Scope, deliberately narrow:
--   * Only system Owner roles. Admin/administrator users get no extra branches; they keep
--     only the branches explicitly given to them. A tenant-authored role that reuses an
--     owner key (isSystem = false) is untouched.
--   * One-shot backfill, no trigger: a later demotion is not undone by an automatic
--     re-grant, and later assignments stay an explicit administrative act.
--   * ON CONFLICT DO NOTHING: an existing row for (organization, branch, user), including
--     one deliberately deactivated, is never reactivated or otherwise changed. No role
--     permission (ALLOW or DENY) is read or written.
-- Forward-only and idempotent.
BEGIN;
SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO "pharmacy_branch_assignments" (
  "id",
  "organizationId",
  "branchId",
  "userId",
  "active",
  "updatedAt"
)
SELECT
  'pbo_' || md5(u."organizationId" || ':' || b."id" || ':' || u."id"),
  u."organizationId",
  b."id",
  u."id",
  true,
  CURRENT_TIMESTAMP
FROM "users" u
JOIN "organizations" o ON o."id" = u."organizationId"
JOIN "organization_roles" r
  ON r."id" = u."organizationRoleId"
 AND r."organizationId" = u."organizationId"
JOIN "pharmacy_branches" b ON b."organizationId" = u."organizationId"
WHERE o."vertical" = 'PHARMACY'::"OrganizationVertical"
  AND r."isSystem" = true
  AND r."key" IN ('owner', 'owner-operator')
  AND b."active" = true
  AND u."status" IN ('ACTIVE'::"UserStatus", 'ON_LEAVE'::"UserStatus")
  AND NOT EXISTS (
    SELECT 1
    FROM "pharmacy_branch_assignments" a
    WHERE a."organizationId" = u."organizationId"
      AND a."branchId" = b."id"
      AND a."userId" = u."id"
  )
ON CONFLICT DO NOTHING;

COMMIT;
