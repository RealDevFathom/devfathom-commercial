-- #654: the pharmacy Pharmacist system template grants 'pharmacy:close' so a
-- pharmacist can reconcile and close the day without the literal ADMIN account
-- role. Templates are copied into organization roles only at provisioning, so
-- Pharmacist roles created before #654 never received the grant and still
-- cannot close the day. Add it to existing system roles keyed 'pharmacist' in
-- PHARMACY organizations only. Tenant-authored lookalikes and other verticals
-- are not widened, and an existing row for the capability (including a DENY)
-- is left untouched. Idempotent.
-- Explicit transaction: Prisma does not run a migration script as one implicit
-- transaction, so without it the transaction-local set_config below would not
-- reach the INSERT and forced RLS would silently match no roles (as #975 found).
BEGIN;

SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO organization_role_permissions
  (id, "organizationId", "organizationRoleId", capability, effect, "createdAt")
SELECT
  'iss654_' || md5(r.id || ':pharmacy:close'),
  r."organizationId",
  r.id,
  'pharmacy:close',
  'ALLOW'::"PermissionEffect",
  now()
FROM organization_roles r
JOIN organizations o ON o.id = r."organizationId"
WHERE o.vertical = 'PHARMACY'
  AND r.key = 'pharmacist'
  AND r."isSystem" = true
ON CONFLICT ("organizationRoleId", capability) DO NOTHING;

COMMIT;
