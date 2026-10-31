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
    SELECT a.after, a."createdAt"
    FROM platform_audit_logs a
    WHERE a."organizationId" = o.id
      AND a."targetType" = 'Organization'
      AND a."targetId" = o.id
      AND a.action IN ('organization.create', 'organization.update',
                       'organization.seat_limit.backfill')
      AND a.success = true
      AND jsonb_typeof(a.after->'seatLimit') = 'number'
      -- Updates audit the entire row, including seats inherited from a contract.
      -- Only an actual seat change establishes a new independent baseline.
      -- Keep legacy updates without a before value as conservative baselines.
      AND (a.action <> 'organization.update'
        OR a.before->'seatLimit' IS DISTINCT FROM a.after->'seatLimit')
    ORDER BY a."createdAt" DESC, a.id DESC
    LIMIT 1
  ) baseline ON true
  WHERE EXISTS (
    SELECT 1
    FROM platform_contracts c
    JOIN platform_audit_logs a
      ON a."organizationId" = c."organizationId"
      AND a."targetType" = 'PlatformContract' AND a."targetId" = c.id
    WHERE c."organizationId" = o.id AND c."seatLimit" = o."seatLimit"
      AND a.action IN ('commercial.contract.create', 'commercial.contract.status')
      AND a.success = true
      AND a.after->'seatLimit' = to_jsonb(o."seatLimit")
      AND a.after->>'status' IN ('ACTIVE', 'GRACE', 'RENEWAL_DUE')
      -- An older contract cannot explain an overwrite of a newer manual limit.
      AND a."createdAt" > baseline."createdAt"
  )
  AND o."seatLimit" <> (baseline.after->>'seatLimit')::integer
), updated AS (
  UPDATE organizations o
  SET "seatLimit" = c.baseline_limit, "updatedAt" = CURRENT_TIMESTAMP
  FROM candidates c
  -- Recheck after any row-lock wait: an operator's concurrent edit wins.
  WHERE o.id = c.id AND o."seatLimit" = c.overwritten_limit
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
