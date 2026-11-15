-- #1241: the pharmacy Pharmacist system template now also grants
-- pharmacy:counter, so a pharmacist can take payment for their own dispensing
-- sale. Tender needs the counter grant and every Rx line needs the payer's exact
-- pharmacy:dispense; before this only the Owner / Operator held both.
-- Existing system roles were created from the earlier template, so add the grant.
-- Only system roles keyed 'pharmacist' in PHARMACY organizations are touched;
-- tenant-authored lookalikes are not widened, and an existing DENY (or any
-- existing row) for the capability is left untouched. Idempotent.
BEGIN;

SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO organization_role_permissions
  (id, "organizationId", "organizationRoleId", capability, effect, "createdAt")
SELECT
  'iss1241_' || md5(r.id || ':pharmacy:counter'),
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
