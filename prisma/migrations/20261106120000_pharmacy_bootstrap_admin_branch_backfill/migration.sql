BEGIN;
-- #479: pharmacovigilance endpoints now require an active pharmacy branch assignment.
-- Provisioning assigns a new pharmacy's bootstrap administrator to MAIN, but pharmacies
-- provisioned after 20261021133000_pharmacy_branch_assignment_backfill left that
-- administrator with no assignment, so a solo owner would lose PV filing and review.
-- Mirror provisioning for exactly those users: an ACTIVE/ON_LEAVE user on a system
-- owner/admin/administrator role in a PHARMACY tenant, who has NO assignment row at all
-- (an inactive row is a deliberate removal and is left alone), gets the active MAIN
-- branch only. Tenant-authored lookalike roles and other verticals are untouched.
-- Idempotent.
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
  'pba_' || md5(u."organizationId" || ':' || b."id" || ':' || u."id"),
  u."organizationId",
  b."id",
  u."id",
  true,
  CURRENT_TIMESTAMP
FROM "users" u
JOIN "organizations" o ON o."id" = u."organizationId"
JOIN "organization_roles" r
  ON r."id" = u."organizationRoleId" AND r."organizationId" = u."organizationId"
JOIN "pharmacy_branches" b
  ON b."organizationId" = u."organizationId" AND b."code" = 'MAIN' AND b."active" = true
WHERE o."vertical" = 'PHARMACY'::"OrganizationVertical"
  AND u."status" IN ('ACTIVE'::"UserStatus", 'ON_LEAVE'::"UserStatus")
  AND r."isSystem" = true
  AND r."key" IN ('owner', 'admin', 'administrator')
  AND NOT EXISTS (
    SELECT 1 FROM "pharmacy_branch_assignments" a
    WHERE a."organizationId" = u."organizationId" AND a."userId" = u."id"
  )
ON CONFLICT ("organizationId", "branchId", "userId") DO NOTHING;

COMMIT;
