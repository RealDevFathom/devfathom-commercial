-- §2.3: package-module inheritance correction (data-only, additive).
--
-- Onboarding, production bootstrap, and the dev seed used to COPY every enabled
-- package module into `organization_modules` (status ENABLED). The entitlement
-- resolver (src/lib/entitlements.ts) layers those rows LAST, as OVERRIDEs, so a
-- copy behaves as a permanent, operator-invisible override: when an org later
-- changed `packageId`, the old package's copies stayed ENABLED and stranded.
-- The copy sites are removed in this change; the package baseline is now
-- inherited live from `platform_package_modules`.
--
-- This migration removes the copies that already exist in a deployed database.
-- It deletes ONLY provably-redundant rows: a copy whose ENABLED state the
-- CURRENT package baseline already provides and that carries no operator- or
-- contract-specified deviation. Anything ambiguous is left untouched
-- (conservative by construction).
--
-- SOURCE SHIFT, NOT STATE CHANGE: removing a redundant copy can change a
-- module's RESOLVED `source` from OVERRIDE to PACKAGE (or CONTRACT, exposing the
-- contract's seat/expiry terms), because the resolver no longer sees an override
-- row. The module's ENABLED state is unchanged — that source shift is exactly
-- the intended correction, not a regression.
--
-- Runs under the migration transaction as the control plane: the RLS policy on
-- `organization_modules` (and the platform_* tables joined below) admits
-- `app.is_platform_admin = 'true'`, so SET LOCAL grants this DML the same
-- control-plane scope `withPlatformDb` uses at runtime. LOCAL keeps it bounded
-- to this transaction.
SET LOCAL app.is_platform_admin = 'true';

-- Redundancy predicate:
--   * the org has a package, and that package's baseline enables this module
--     (pm.enabled) for an active module (m.active);
--   * the copy is ENABLED with no operator deviation (no seatLimit, no
--     expiresAt, no overrides);
--   * its reason is either the onboarding marker for the CURRENT package name
--     ('Included with <package>') or NULL (bootstrap/seed copies).
-- Operator overrides always carry a reason >= 5 chars (organization.module zod
-- schema) and contract rows carry 'Contract <number>', so neither can match.
DELETE FROM "organization_modules" om
USING "organizations" o, "platform_packages" p, "platform_package_modules" pm, "platform_modules" m
WHERE o.id = om."organizationId" AND o."packageId" IS NOT NULL
  AND p.id = o."packageId"
  AND pm."packageId" = p.id AND pm."moduleId" = om."moduleId" AND pm.enabled = true
  AND m.id = om."moduleId" AND m.active = true
  AND om.status = 'ENABLED'
  AND om."seatLimit" IS NULL AND om."expiresAt" IS NULL AND om.overrides IS NULL
  AND (om.reason = 'Included with ' || p.name OR om.reason IS NULL);

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
