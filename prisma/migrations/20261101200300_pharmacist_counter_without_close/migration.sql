-- #996: the pharmacy Pharmacist system template no longer grants day close
-- (`pharmacy:close`, a manager-or-owner action that also unlocked drawer
-- movements and drawer close). Existing system roles were created from the
-- earlier template, so bring them in line with the new one. Counter selling
-- (`pharmacy:counter`) is not granted here; that decision is pending in
-- DEV-622 / DEV-97.
-- Only system roles keyed 'pharmacist' in PHARMACY organizations are touched;
-- tenant-authored lookalikes and other verticals are left alone. Only the
-- ALLOW row for `pharmacy:close` is removed (an explicit DENY stays).
-- Idempotent.
BEGIN;

SELECT set_config('app.is_platform_admin', 'true', true);

DELETE FROM organization_role_permissions p
USING organization_roles r, organizations o
WHERE p."organizationRoleId" = r.id
  AND o.id = r."organizationId"
  AND o.vertical = 'PHARMACY'
  AND r.key = 'pharmacist'
  AND r."isSystem" = true
  AND p.capability = 'pharmacy:close'
  AND p.effect = 'ALLOW'::"PermissionEffect";

COMMIT;
