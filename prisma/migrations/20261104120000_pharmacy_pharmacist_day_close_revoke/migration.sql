-- DEV-739 / DEV-32, rollout phase 1 of 2: pharmacy day close is for owners,
-- administrators and managers only (Saad, 2026-11-01, reaffirmed on DEV-739).
-- Pharmacists never close the day by default.
--
-- #654 put 'pharmacy:close' on the Pharmacist system template, so Pharmacist
-- roles provisioned since then carry a template ALLOW. This migration removes
-- that ALLOW from system 'pharmacist' roles in PHARMACY organizations. It only
-- ever removes access, so it is safe while the previous application revision
-- is still serving (the migration job runs before the new revision is live).
--
-- Deliberately NOT here: the backfill that gives existing system 'manager'
-- roles 'pharmacy:close'. The previous revision's close gate has no branch
-- assignment check, so granting managers before the new revision serves would
-- let them close any branch. That backfill ships as rollout phase 2, after this
-- revision is live everywhere (see docs/operations/pharmacy-day-close-rollout.md).
--
-- Only the ALLOW row for exactly 'pharmacy:close' is removed: an explicit DENY,
-- other capabilities, tenant-authored roles, user overrides and other verticals
-- are untouched. Idempotent: phase 2 re-runs it to catch roles a previous
-- revision provisioned during the deploy.
-- Explicit transaction: Prisma does not run a migration script as one implicit
-- transaction, so without it the transaction-local set_config below would not
-- reach the DELETE and forced RLS would silently match no rows (as #975 found).
BEGIN;

SELECT set_config('app.is_platform_admin', 'true', true);

DELETE FROM organization_role_permissions p
USING organization_roles r, organizations o
WHERE p."organizationRoleId" = r.id
  AND p."organizationId" = r."organizationId"
  AND o.id = r."organizationId"
  AND o.vertical = 'PHARMACY'
  AND r.key = 'pharmacist'
  AND r."isSystem" = true
  AND p.capability = 'pharmacy:close'
  AND p.effect = 'ALLOW'::"PermissionEffect";

COMMIT;
