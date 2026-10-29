BEGIN;

SELECT set_config('app.is_platform_admin', 'true', true);

-- Contract synchronization used to copy a temporary allowance onto the durable
-- organization row. Restore only rows for which both sides of that overwrite
-- can be proven: the current value is a contract value, and an Organization
-- audit records the independently configured value that preceded it.
WITH candidates AS (
  SELECT o.id, o."seatLimit" AS overwritten_limit,
         (baseline.after->>'seatLimit')::integer AS baseline_limit
  FROM organizations o
  JOIN LATERAL (
    SELECT a.after
    FROM platform_audit_logs a
    WHERE a."organizationId" = o.id
      AND a."targetType" = 'Organization'
      AND a."targetId" = o.id
      AND a.action IN ('organization.create', 'organization.update',
                       'organization.seat_limit.backfill')
      AND jsonb_typeof(a.after->'seatLimit') = 'number'
    ORDER BY a."createdAt" DESC, a.id DESC
    LIMIT 1
  ) baseline ON true
  WHERE EXISTS (
    SELECT 1 FROM platform_contracts c
    WHERE c."organizationId" = o.id AND c."seatLimit" = o."seatLimit"
  )
  AND EXISTS (
    SELECT 1 FROM platform_audit_logs a
    WHERE a."organizationId" = o.id
      AND a.action IN ('commercial.contract.create', 'commercial.contract.status')
  )
  AND o."seatLimit" <> (baseline.after->>'seatLimit')::integer
), updated AS (
  UPDATE organizations o
  SET "seatLimit" = c.baseline_limit, "updatedAt" = CURRENT_TIMESTAMP
  FROM candidates c
  WHERE o.id = c.id
  RETURNING o.id, c.overwritten_limit, c.baseline_limit
)
INSERT INTO platform_audit_logs
  (id, "organizationId", action, "targetType", "targetId", before, after, reason)
SELECT 'seat_contract_restore_' || md5(id || ':20261029000376'), id,
       'organization.seat_limit.contract_restore', 'Organization', id,
       jsonb_build_object('seatLimit', overwritten_limit),
       jsonb_build_object('seatLimit', baseline_limit),
       'Restore organization seat limit overwritten by contract synchronization (#406)'
FROM updated;

COMMIT;
