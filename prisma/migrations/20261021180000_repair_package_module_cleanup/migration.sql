-- Replay data changes from 20260818120000_package_module_inheritance_cleanup (#218).
-- Explicit transaction keeps platform scope alive across statements.
-- Original migrations remain immutable; predicates/conflict handling permit replay.
BEGIN;
SELECT set_config('app.is_platform_admin', 'true', true);

DELETE FROM "organization_modules" om
USING "organizations" o, "platform_packages" p, "platform_package_modules" pm, "platform_modules" m
WHERE o.id = om."organizationId" AND o."packageId" IS NOT NULL
  AND p.id = o."packageId"
  AND pm."packageId" = p.id AND pm."moduleId" = om."moduleId" AND pm.enabled = true
  AND m.id = om."moduleId" AND m.active = true
  AND om.status = 'ENABLED'
  AND om."seatLimit" IS NULL AND om."expiresAt" IS NULL AND om.overrides IS NULL
  AND om.reason = 'Included with ' || p.name;

-- Surface, but never delete, onboarding-marked copies that did NOT match the
-- predicate above (e.g. the org's package changed since onboarding so the name
-- no longer lines up, or the row now carries a seat/expiry/override deviation).
-- These survive by design and are left for operator review. Follows the
-- user_email_lowercase house style (WARNING inside a DO block; do not abort).
DO $$
DECLARE
  survivors INT;
BEGIN
  SELECT count(*) INTO survivors
  FROM "organization_modules"
  WHERE reason LIKE 'Included with %';

  IF survivors > 0 THEN
    RAISE WARNING
      'package_module_inheritance_cleanup: % organization_modules row(s) still carry an '
      '"Included with <package>" reason after cleanup. They were left in place because the '
      'current package baseline does not provably cover them (the package likely changed since '
      'onboarding) or they carry a seat/expiry/override deviation. Review them by hand; their '
      'enabled-state is unchanged and nothing was deleted for them.',
      survivors;
  END IF;
END $$;

COMMIT;
