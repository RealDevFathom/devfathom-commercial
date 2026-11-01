-- QA-304: remove stale package-denying overrides emitted by the former contract sync.
--
-- There is no dedicated provenance column on organization_modules. The old sync is
-- identified conservatively by the complete shape it wrote for an excluded module:
-- DISABLED, no expiry/seat/JSON override, and reason = 'Contract <number>' for a
-- contract belonging to the same organization. The module must also be enabled by
-- that organization's current package. Requiring the empty override fields preserves
-- admin-customized rows, including rows that the old sync may subsequently have
-- touched. Ambiguous rows are intentionally retained for manual review.
--
-- The catalog tables are guarded because this is a data repair and should be safe to
-- replay (or inspect against an incomplete/legacy schema). DELETE is intrinsically
-- idempotent: after the first run no qualifying row remains.
DO $qa304$
BEGIN
  IF to_regclass('organization_modules') IS NOT NULL
     AND to_regclass('organizations') IS NOT NULL
     AND to_regclass('platform_package_modules') IS NOT NULL
     AND to_regclass('platform_contracts') IS NOT NULL THEN
    PERFORM set_config('app.is_platform_admin', 'true', true);

    DELETE FROM organization_modules AS om
    USING organizations AS o, platform_package_modules AS pm
    WHERE o.id = om."organizationId"
      AND o."packageId" IS NOT NULL
      AND pm."packageId" = o."packageId"
      AND pm."moduleId" = om."moduleId"
      AND pm.enabled = true
      AND om.status::text = 'DISABLED'
      AND om."expiresAt" IS NULL
      AND om."seatLimit" IS NULL
      AND om.overrides IS NULL
      AND EXISTS (
        SELECT 1
        FROM platform_contracts AS c
        WHERE c."organizationId" = om."organizationId"
          AND om.reason = 'Contract ' || c.number
      );
  END IF;
END
$qa304$;
