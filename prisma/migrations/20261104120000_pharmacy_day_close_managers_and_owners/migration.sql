-- DEV-739 / DEV-32: pharmacy day close is for managers and owners only
-- (Saad, 2026-11-01, reaffirmed on DEV-739). Pharmacists never close the day.
--
-- #654 put 'pharmacy:close' on the Pharmacist system template, so Pharmacist
-- roles provisioned since then carry a template ALLOW. Templates are copied
-- into organization roles only at provisioning, so existing roles must be
-- reconciled here as well as the template being corrected:
--   1. remove the template ALLOW of 'pharmacy:close' from system 'pharmacist'
--      roles in PHARMACY organizations;
--   2. give system 'manager' roles in PHARMACY organizations the
--      'pharmacy:close' ALLOW the corrected template now carries.
-- Owner ('pharmacy:*') and Owner / Operator (exact grant) roles already close.
-- An explicit DENY on either role is never removed or overridden: step 1
-- deletes ALLOW rows only, and step 2 leaves any existing row (including a
-- DENY) untouched. Tenant-authored roles, user overrides and other verticals
-- are not touched. Idempotent.
-- Explicit transaction: Prisma does not run a migration script as one implicit
-- transaction, so without it the transaction-local set_config below would not
-- reach the statements and forced RLS would silently match no rows (as #975 found).
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

INSERT INTO organization_role_permissions
  (id, "organizationId", "organizationRoleId", capability, effect, "createdAt")
SELECT
  'dev739_' || md5(r.id || ':pharmacy:close'),
  r."organizationId",
  r.id,
  'pharmacy:close',
  'ALLOW'::"PermissionEffect",
  now()
FROM organization_roles r
JOIN organizations o ON o.id = r."organizationId"
WHERE o.vertical = 'PHARMACY'
  AND r.key = 'manager'
  AND r."isSystem" = true
ON CONFLICT ("organizationRoleId", capability) DO NOTHING;

COMMIT;
