-- DEV-665: repair the bootstrap assignment omitted after the one-time 20261021 backfill.
-- withPlatformDb creates the organization, sole bootstrap user, MAIN branch,
-- system roles and successful platform audit in one transaction (now() is stable).
-- Require that unambiguous cohort; imported/unaudited or changed identities need
-- an explicit administrator-reviewed assignment through the existing workflow.
BEGIN;
SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO "pharmacy_branch_assignments" (
  "id", "organizationId", "branchId", "userId", "active", "updatedAt"
)
SELECT
  'pba_' || md5(o."id" || ':' || b."id" || ':' || u."id"),
  o."id", b."id", u."id", true, CURRENT_TIMESTAMP
FROM "organizations" o
JOIN "users" u ON u."organizationId" = o."id" AND u."createdAt" = o."createdAt"
JOIN "pharmacy_branches" b
  ON b."organizationId" = o."id" AND b."createdAt" = o."createdAt"
JOIN "organization_roles" r
  ON r."id" = u."organizationRoleId" AND r."organizationId" = o."id"
WHERE o."vertical" = 'PHARMACY'::"OrganizationVertical"
  AND o."status" IN ('ONBOARDING'::"OrganizationStatus", 'ACTIVE'::"OrganizationStatus")
  AND o."isDemo" = false
  AND b."code" = 'MAIN'
  AND b."active" = true
  AND u."role" = 'ADMIN'::"Role"
  AND u."status" IN ('ACTIVE'::"UserStatus", 'ON_LEAVE'::"UserStatus")
  AND r."isSystem" = true
  AND r."createdAt" = o."createdAt"
  -- A subset of the shipped backfill's eligible roles/capabilities, not a new grant.
  AND (
    r."key" IN ('owner', 'owner-operator')
    OR (r."key" = 'admin' AND EXISTS (
      SELECT 1 FROM "organization_role_permissions" p
      WHERE p."organizationId" = o."id"
        AND p."organizationRoleId" = r."id"
        AND p."effect" = 'ALLOW'::"PermissionEffect"
        AND p."capability" = '*'
    ))
  )
  AND NOT EXISTS (
    SELECT 1 FROM "users" other
    WHERE other."organizationId" = o."id"
      AND other."createdAt" = o."createdAt"
      AND other."id" <> u."id"
  )
  AND EXISTS (
    SELECT 1 FROM "platform_audit_logs" audit
    WHERE audit."organizationId" = o."id"
      AND audit."targetId" = o."id"
      AND audit."targetType" = 'Organization'
      AND audit."action" IN ('organization.create', 'crm.opportunity.convert')
      AND audit."success" = true
      AND audit."createdAt" = o."createdAt"
  )
-- Preserve existing assignments, including explicit inactive/revoked rows.
ON CONFLICT ("organizationId", "branchId", "userId") DO NOTHING;
COMMIT;
