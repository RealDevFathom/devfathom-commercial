BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL app.is_platform_admin = 'true';

DO $$
DECLARE
  org record;
  restaurant_present boolean;
BEGIN
  -- Serialize writers and migration replays while continuing to admit ordinary reads.
  LOCK TABLE restaurant_staff_profiles IN SHARE MODE;
  LOCK TABLE restaurant_operator_credentials IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (
    SELECT 1 FROM pg_attribute WHERE attrelid = 'restaurant_operator_credentials'::regclass
      AND attname = 'approvalPinMustChange' AND NOT attisdropped
  ) THEN
    RETURN;
  END IF;

  CREATE TEMP TABLE shared_pin_changes (
    organization_id text NOT NULL, credential_id text PRIMARY KEY, member_id text NOT NULL
  ) ON COMMIT DROP;

  FOR org IN SELECT id, "packageId" FROM organizations WHERE NOT "isDemo" ORDER BY id LOOP
    PERFORM set_config('app.current_organization_id', org.id, true);

    -- Same effective module sources and override precedence as resolveOrganizationEntitlements.
    SELECT EXISTS (
      SELECT 1 FROM platform_modules m
      LEFT JOIN organization_modules om ON om."moduleId" = m.id AND om."organizationId" = org.id
      WHERE m.active AND m.key LIKE 'restaurant-%' AND (
        m.band = 'BASELINE' OR CASE WHEN om.id IS NOT NULL THEN
          om.status IN ('ENABLED', 'TRIAL') AND om."startsAt" <= now()
          AND (om."expiresAt" IS NULL OR om."expiresAt" > now())
        ELSE EXISTS (
          SELECT 1 FROM platform_package_modules pm
          WHERE pm."packageId" = org."packageId" AND pm."moduleId" = m.id AND pm.enabled
        ) OR EXISTS (
          SELECT 1 FROM platform_contracts c JOIN platform_contract_modules cm ON cm."contractId" = c.id
          WHERE c."organizationId" = org.id AND cm."moduleId" = m.id
            AND c.status IN ('ACTIVE','GRACE','RENEWAL_DUE') AND c."startDate" <= now()
            AND (c."endDate" >= now() OR c."graceUntil" >= now())
        ) END
      )
    ) INTO restaurant_present;

    WITH history AS (
      SELECT c.id, c."createdAt", c."revokedAt", p."userId",
        rank() OVER (PARTITION BY p."userId" ORDER BY c."createdAt") AS issuance,
        count(*) OVER (PARTITION BY p."userId", c."createdAt") AS issued_together
      FROM restaurant_operator_credentials c JOIN restaurant_staff_profiles p
        ON p.id = c."staffProfileId" AND p."organizationId" = org.id
      WHERE c."organizationId" = org.id AND c.type = 'PIN' AND c."deviceId" IS NULL
        AND p."userId" IS NOT NULL
    ), writes AS (
      SELECT a."createdAt", a."actorType", a."actorId",
        coalesce(a.metadata, '{}'::jsonb) ?| ARRAY['supportSessionId', 'actingAsTenantUserId', 'platformUserId'] AS support,
        CASE
          WHEN a."targetType" = 'RestaurantOperatorCredential' THEN a."targetId"
          WHEN a.action IN ('pharmacyPin.setMine','accountPin.setMine') AND a."targetType" = 'User'
            THEN a.metadata->>'credentialId'
        END AS credential_id,
        a.action = 'pharmacyPurchasing.provisionMyPurchasePin' AND a."targetId" IS NULL AS untargeted_provision
      FROM audit_logs a
      WHERE a."organizationId" = org.id AND a.source = 'TRPC' AND a.outcome = 'SUCCESS'
        AND a.action IN ('restaurantStaff.issueCredential','restaurantStaff.rotateCredential',
          'pharmacyPin.setMine','accountPin.setMine','pharmacyPurchasing.provisionMyPurchasePin')
    ), setters AS (
      SELECT h.id, w."createdAt", (w."actorType" = 'USER' AND w."actorId" IS NOT DISTINCT FROM h."userId"
        AND NOT w.support) AS member_set
      FROM history h JOIN writes w ON w.credential_id = h.id
      WHERE h."revokedAt" IS NULL
      UNION ALL
      -- Historical purchase provisioning logged its actor but no target. It could only
      -- issue that person's first shared PIN, including revoked PINs in the prior-PIN check.
      SELECT h.id, w."createdAt", w."actorType" = 'USER' AND NOT w.support
      FROM history h JOIN writes w ON w.untargeted_provision AND w."actorId" = h."userId"
      WHERE h."revokedAt" IS NULL AND h.issuance = 1 AND h.issued_together = 1
        AND h."createdAt" <= w."createdAt"
    ), latest AS (
      -- At identical audit times conflicting attribution cannot establish a member set.
      SELECT DISTINCT ON (id) id, member_set FROM setters ORDER BY id, "createdAt" DESC, member_set
    )
    INSERT INTO shared_pin_changes
    SELECT org.id, h.id, h."userId" FROM history h LEFT JOIN latest l ON l.id = h.id
    WHERE h."revokedAt" IS NULL AND coalesce(NOT l.member_set, restaurant_present);
  END LOOP;

  -- The historical audit scan is complete before ALTER takes ACCESS EXCLUSIVE.
  ALTER TABLE restaurant_operator_credentials
    ADD COLUMN IF NOT EXISTS "approvalPinMustChange" boolean NOT NULL DEFAULT false;
  FOR org IN SELECT DISTINCT organization_id AS id FROM shared_pin_changes LOOP
    PERFORM set_config('app.current_organization_id', org.id, true);
    UPDATE restaurant_operator_credentials c SET "approvalPinMustChange" = true
    FROM shared_pin_changes s WHERE s.organization_id = org.id AND c."organizationId" = org.id
      AND c.id = s.credential_id;
    INSERT INTO notifications (id, "organizationId", "userId", type, title, message)
    SELECT gen_random_uuid()::text, org.id, member_id, 'approval_pin_must_change',
      'Set a new approval PIN', 'Set a new PIN with your password in Settings, Your PIN before approving with a PIN.'
    FROM (SELECT DISTINCT member_id FROM shared_pin_changes WHERE organization_id = org.id) members;
  END LOOP;
END $$;
COMMIT;
