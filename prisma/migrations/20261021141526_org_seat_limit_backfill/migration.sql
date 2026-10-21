BEGIN;

-- Migration jobs run before catalog sync. Repair legacy hospitality packages first
-- so the organization backfill also works on the first deployment.
SELECT set_config('app.is_platform_admin', 'true', true);

UPDATE platform_packages p
SET "defaultSeats" = defaults.seats, "updatedAt" = CURRENT_TIMESTAMP
FROM (VALUES ('hotel-essentials', 15), ('hotel-pro', 75),
             ('hotel-chain', 2500), ('hotel-venue', 25)) AS defaults(key, seats)
WHERE p.key = defaults.key AND p.vertical = 'HOSPITALITY'
  AND p."defaultSeats" = 1;

-- Capture only rows actually changed; the audit and update succeed atomically.
WITH updated AS (
  UPDATE organizations o
  SET "seatLimit" = p."defaultSeats", "updatedAt" = CURRENT_TIMESTAMP
  FROM platform_packages p
  WHERE o."packageId" = p.id AND o."seatLimit" = 1 AND p."defaultSeats" > 1
  AND o."isDemo" = false
  -- Contract terms remain authoritative, including historical contract audits.
  AND NOT EXISTS (
    SELECT 1 FROM platform_contracts c WHERE c."organizationId" = o.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM platform_audit_logs a
    WHERE a."organizationId" = o.id
      AND a.action IN ('commercial.contract.create', 'commercial.contract.status')
  )
  -- Require creation provenance and preserve explicit single-seat onboarding.
  AND EXISTS (
    SELECT 1 FROM platform_audit_logs a
    WHERE a."organizationId" = o.id AND a.action = 'organization.create'
      AND a."targetType" = 'Organization' AND a."targetId" = o.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM platform_audit_logs a
    WHERE a."organizationId" = o.id AND a.action = 'organization.create'
      AND a.after @> '{"seatLimit": 1}'::jsonb
  )
  -- Preserve explicit operator limits recorded by organization.update.
  AND NOT EXISTS (
    SELECT 1 FROM platform_audit_logs a
    WHERE a."organizationId" = o.id
      AND a.action = 'organization.update'
      AND a."targetType" = 'Organization' AND a."targetId" = o.id
      AND a.after @> '{"seatLimit": 1}'::jsonb
  )
  RETURNING o.id, o."packageId", o."seatLimit"
)
INSERT INTO platform_audit_logs
  (id, "organizationId", action, "targetType", "targetId", before, after, reason)
SELECT 'seat_backfill_' || md5(id || ':20261021141526'), id,
       'organization.seat_limit.backfill', 'Organization', id,
       jsonb_build_object('seatLimit', 1),
       jsonb_build_object('seatLimit', "seatLimit", 'packageId', "packageId"),
       'Repair legacy single-seat package inheritance (#206)'
FROM updated;

COMMIT;
