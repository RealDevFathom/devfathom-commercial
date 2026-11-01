-- #996: the pharmacy Pharmacist system template no longer grants day close
-- (`pharmacy:close`, a manager-or-owner action that also unlocked drawer
-- movements and drawer close) and now grants counter selling
-- (`pharmacy:counter`: Tender, Take payment, and the counter Khata / manual
-- wallet tenders that ride on it). Existing system roles were created from the
-- earlier template, so bring them in line with the new one.
-- Only system roles keyed 'pharmacist' in PHARMACY organizations are touched;
-- tenant-authored lookalikes and other verticals are left alone. Only the
-- ALLOW row for `pharmacy:close` is removed (an explicit DENY stays), and an
-- existing row for `pharmacy:counter` (including a DENY) is left untouched.
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

INSERT INTO organization_role_permissions
  (id, "organizationId", "organizationRoleId", capability, effect, "createdAt")
SELECT
  'iss996_' || md5(r.id || ':pharmacy:counter'),
  r."organizationId",
  r.id,
  'pharmacy:counter',
  'ALLOW'::"PermissionEffect",
  now()
FROM organization_roles r
JOIN organizations o ON o.id = r."organizationId"
WHERE o.vertical = 'PHARMACY'
  AND r.key = 'pharmacist'
  AND r."isSystem" = true
ON CONFLICT ("organizationRoleId", capability) DO NOTHING;

COMMIT;
