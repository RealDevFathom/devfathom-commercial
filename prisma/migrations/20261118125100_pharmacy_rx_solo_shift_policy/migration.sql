BEGIN;

-- DEV-960: the owner setting "One pharmacist per shift", per branch, OFF by default.
--
-- The solo rule (DEV-950) lets the pharmacist who rang up a prescription line sign its review
-- with a fresh PIN only when nobody else on the branch's staff list could sign it. A branch with
-- two pharmacists on the list but one per shift is stuck. With this setting on at a branch, the
-- pharmacist on duty may sign their own line by re-entering their PIN and declaring "I am the only
-- pharmacist on duty now". The application writes that sign-off through the same path as the solo
-- rule, so the review trigger (20261118124600) still demands the same self-approved, PIN-verified
-- audit entry and still refuses every controlled medicine; that trigger is not changed.
--
-- Storage is one append-only row per change ("pharmacy_rx_solo_shift_policy_changes"): the newest
-- row of a branch (highest version) is the setting in force, and no row means OFF. Every row is
-- the audit of that change: who, when, from what (the version before it) to what, and the
-- statement the owner accepted. Whoever writes it, the database:
--   * takes the branch's setting lock, so changes serialize and a sign-off reading the setting
--     (which takes the same lock shared) sees either the old or the new setting, never both;
--   * requires the writer to be the session's own user (app.current_user_id), ACTIVE in this
--     organization, holding its system `owner` role, with no live DENY on '*', 'pharmacy:*',
--     'pharmacy:manage' or 'pharmacy:dispense' (the DEV-911 owner rule). An ADMIN without the
--     owner role, a manager, a pharmacist and a cashier are refused;
--   * refuses a row that changes nothing, numbers the version itself (one more than the last),
--     and stamps the actor and time;
--   * requires the accepted statement on a row that turns the setting ON.
-- Rows are never updated or deleted. Row-level security is forced, by organization and by the
-- session's branch when one is set. Idempotent: IF NOT EXISTS, CREATE OR REPLACE, DROP ... IF
-- EXISTS before each trigger and policy.

CREATE TABLE IF NOT EXISTS "pharmacy_rx_solo_shift_policy_changes" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "disclaimerVersion" TEXT,
  "acknowledgement" TEXT,
  "actorUserId" TEXT NOT NULL,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_rx_solo_shift_policy_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_rx_solo_shift_policy_changes_org_fkey" FOREIGN KEY ("organizationId")
    REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "pharmacy_rx_solo_shift_policy_changes_branch_fkey" FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pharmacy_rx_solo_shift_policy_changes_version_check" CHECK ("version" > 0),
  CONSTRAINT "pharmacy_rx_solo_shift_policy_changes_ack_check" CHECK (
    ("enabled" = true
      AND length(btrim(COALESCE("acknowledgement", ''))) BETWEEN 1 AND 4000
      AND length(btrim(COALESCE("disclaimerVersion", ''))) BETWEEN 1 AND 100)
    OR ("enabled" = false AND "acknowledgement" IS NULL AND "disclaimerVersion" IS NULL)
  )
);

-- One row per version per branch: the setting in force is never ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_rx_solo_shift_policy_changes_version_key"
  ON "pharmacy_rx_solo_shift_policy_changes" ("organizationId", "branchId", "version");

-- The setting lock of one branch: the owner's change takes it exclusively (below), a declared
-- sign-off takes it shared while it reads the setting, inside the signature's transaction.
CREATE OR REPLACE FUNCTION pharmacy_rx_solo_shift_lock_key(p_organization_id text, p_branch_id text)
RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT hashtextextended('pharmacy_rx_solo_shift:' || p_organization_id || ':' || p_branch_id, 0)
$$;

CREATE OR REPLACE FUNCTION pharmacy_rx_solo_shift_policy_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor text;
  last_enabled boolean;
  last_version integer;
BEGIN
  IF NEW."organizationId" IS NULL OR NEW."branchId" IS NULL OR NEW."enabled" IS NULL THEN
    RAISE EXCEPTION 'RX_SOLO_SHIFT_POLICY_INVALID' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(pharmacy_rx_solo_shift_lock_key(NEW."organizationId", NEW."branchId"));

  actor := NULLIF(current_setting('app.current_user_id', true), '');
  IF actor IS NULL OR NEW."actorUserId" IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'RX_SOLO_SHIFT_POLICY_ACTOR_REQUIRED' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM "users" u
      JOIN "organization_roles" r
        ON r."id" = u."organizationRoleId" AND r."organizationId" = u."organizationId"
     WHERE u."id" = actor
       AND u."organizationId" = NEW."organizationId"
       AND u."status" = 'ACTIVE'
       AND r."isSystem" AND r."key" = 'owner'
       AND NOT EXISTS (
         SELECT 1 FROM "organization_role_permissions" p
          WHERE p."organizationRoleId" = u."organizationRoleId" AND p."effect" = 'DENY'
            AND p."capability" IN ('*', 'pharmacy:*', 'pharmacy:manage', 'pharmacy:dispense')
       )
       AND NOT EXISTS (
         SELECT 1 FROM "user_permission_overrides" o
          WHERE o."userId" = u."id" AND o."effect" = 'DENY'
            AND o."capability" IN ('*', 'pharmacy:*', 'pharmacy:manage', 'pharmacy:dispense')
            AND (o."expiresAt" IS NULL OR o."expiresAt" > CURRENT_TIMESTAMP)
       )
  ) THEN
    RAISE EXCEPTION 'RX_SOLO_SHIFT_POLICY_OWNER_REQUIRED' USING ERRCODE = '42501';
  END IF;

  SELECT c."enabled", c."version" INTO last_enabled, last_version
    FROM "pharmacy_rx_solo_shift_policy_changes" c
   WHERE c."organizationId" = NEW."organizationId" AND c."branchId" = NEW."branchId"
   ORDER BY c."version" DESC
   LIMIT 1;
  IF NOT FOUND THEN
    -- No row means OFF.
    last_enabled := false;
    last_version := 0;
  END IF;
  IF NEW."enabled" IS NOT DISTINCT FROM last_enabled THEN
    RAISE EXCEPTION 'RX_SOLO_SHIFT_POLICY_UNCHANGED' USING ERRCODE = '23514';
  END IF;
  IF NEW."enabled" THEN
    IF length(btrim(COALESCE(NEW."acknowledgement", ''))) = 0
       OR length(btrim(COALESCE(NEW."disclaimerVersion", ''))) = 0 THEN
      RAISE EXCEPTION 'RX_SOLO_SHIFT_POLICY_DISCLAIMER_REQUIRED' USING ERRCODE = '23514';
    END IF;
  ELSE
    NEW."acknowledgement" := NULL;
    NEW."disclaimerVersion" := NULL;
  END IF;

  NEW."version" := last_version + 1;
  NEW."actorUserId" := actor;
  NEW."changedAt" := CURRENT_TIMESTAMP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pharmacy_rx_solo_shift_policy_guard ON "pharmacy_rx_solo_shift_policy_changes";
CREATE TRIGGER pharmacy_rx_solo_shift_policy_guard
  BEFORE INSERT ON "pharmacy_rx_solo_shift_policy_changes"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_rx_solo_shift_policy_guard();

DROP TRIGGER IF EXISTS pharmacy_rx_solo_shift_policy_append_only ON "pharmacy_rx_solo_shift_policy_changes";
CREATE TRIGGER pharmacy_rx_solo_shift_policy_append_only
  BEFORE UPDATE OR DELETE ON "pharmacy_rx_solo_shift_policy_changes"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_mutation();

ALTER TABLE "pharmacy_rx_solo_shift_policy_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_rx_solo_shift_policy_changes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_branch_isolation ON "pharmacy_rx_solo_shift_policy_changes";
CREATE POLICY tenant_branch_isolation ON "pharmacy_rx_solo_shift_policy_changes"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
        AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
             OR "branchId" = current_setting('app.current_branch_id', true)))
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
        AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
             OR "branchId" = current_setting('app.current_branch_id', true)))
  );

COMMIT;
