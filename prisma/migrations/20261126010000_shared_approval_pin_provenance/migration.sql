BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE restaurant_operator_credentials
  ADD COLUMN "approvalPinMustChange" boolean NOT NULL DEFAULT false;

-- A restricted owner enumerates organizations, then runs each change under its tenant policy.
SET LOCAL app.is_platform_admin = 'true';
DO $$
DECLARE tenant text;
BEGIN
  FOR tenant IN SELECT id FROM organizations ORDER BY id LOOP
    PERFORM set_config('app.current_organization_id', tenant, true);
    WITH flagged AS (
      UPDATE restaurant_operator_credentials c SET "approvalPinMustChange" = true
      FROM restaurant_staff_profiles p
      WHERE c."organizationId" = tenant AND p."organizationId" = tenant
        AND p.id = c."staffProfileId" AND p."userId" IS NOT NULL
        AND c.type = 'PIN' AND c."deviceId" IS NULL AND c."revokedAt" IS NULL
        -- Require affirmative evidence of a member write to this live PIN. If the
        -- row has changed since the recorded event (including lockout bookkeeping),
        -- the evidence is inconclusive. Conflicting attribution also requires a change.
        AND (SELECT bool_and(a."actorId" IS NOT DISTINCT FROM p."userId"
               AND NOT (coalesce(a.metadata, '{}'::jsonb) ? 'supportSessionId'))
             FROM audit_logs a
             WHERE a."organizationId" = tenant AND a.source = 'TRPC'
               AND a.outcome = 'SUCCESS' AND a."actorType" = 'USER'
               AND a."createdAt" >= c."updatedAt"
               AND ((a."targetType" = 'RestaurantOperatorCredential' AND a."targetId" = c.id
                     AND a.action IN ('restaurantStaff.issueCredential','restaurantStaff.rotateCredential'))
                 OR (a.action = 'pharmacyPin.setMine' AND a."targetType" = 'User'
                     AND a."targetId" = p."userId" AND a.metadata->>'staffProfileId' = p.id))
            ) IS DISTINCT FROM true
      RETURNING p."userId"
    )
    INSERT INTO notifications (id, "organizationId", "userId", type, title, message)
    SELECT gen_random_uuid()::text, tenant, member, 'approval_pin_must_change',
      'Set a new approval PIN', 'Set a new PIN with your password in Settings, Your PIN before approving with a PIN.'
    FROM (SELECT DISTINCT "userId" AS member FROM flagged) members;
  END LOOP;
END $$;
COMMIT;
