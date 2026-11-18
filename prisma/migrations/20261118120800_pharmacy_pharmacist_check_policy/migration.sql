BEGIN;

-- DEV-911: owner switch for the pharmacist check and prescription record at each sale.
--
-- Reuses the #518 owner-policy storage (20261023010518_pharmacy_owner_policy) the same
-- way DEV-753 did: one "pharmacy_owner_policies" row per organization (FORCE RLS), and the
-- append-only "pharmacy_owner_policy_audit" written by trigger whoever writes the row.
--
-- "pharmacistCheckEnabled" defaults to ON and a missing row means ON, so every pharmacy,
-- existing and new, keeps today's checks. Only the tenant owner (this organization's
-- system `owner` role) can turn it off, with the accepted disclaimer recorded. The
-- application decides this first; the database refuses any other writer too.
--
-- While it is off, a controlled sale, void or return still writes its controlled register
-- entry. That entry has no independent pharmacist witness, so it carries the marker
-- 'pharmacist-check-off:v<policy version>' and the database accepts it only while the
-- stored setting really is off at that version. A prescription-only refill cycle readied
-- without a pharmacist carries the same marker as its approval policy, under the same rule.

ALTER TABLE "pharmacy_owner_policies"
  ADD COLUMN IF NOT EXISTS "pharmacistCheckEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "pharmacistCheckPolicyVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "pharmacistCheckAcknowledgement" TEXT;

-- The version and acknowledgement move only with the value, whoever writes the row: each
-- effective change bumps the version by one, and turning the check off needs the accepted
-- disclaimer. An effective change must name the session's own user (app.current_user_id)
-- as the actor, and that user must be ACTIVE in this organization, hold its system
-- `owner` role, and carry no live DENY on '*', 'pharmacy:*', 'pharmacy:manage' or
-- 'pharmacy:dispense'. An ADMIN without the owner role is refused. Versions continue from
-- the audit trail, so recreating the row never reuses a version a register entry cites.
CREATE OR REPLACE FUNCTION pharmacy_owner_policy_pharmacist_check_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  changed boolean;
  actor text;
  last_version integer := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A missing row already means ON, so only an inserted OFF is a change.
    changed := NEW."pharmacistCheckEnabled" IS DISTINCT FROM true;
    SELECT COALESCE(MAX("policyVersion"), 0) INTO last_version
      FROM "pharmacy_owner_policy_audit"
     WHERE "organizationId" = NEW."organizationId"
       AND "setting" = 'pharmacistCheckEnabled';
  ELSE
    changed := NEW."pharmacistCheckEnabled" IS DISTINCT FROM OLD."pharmacistCheckEnabled";
  END IF;

  IF NOT changed THEN
    IF TG_OP = 'INSERT' THEN
      NEW."pharmacistCheckPolicyVersion" := last_version;
      NEW."pharmacistCheckAcknowledgement" := NULL;
    ELSE
      NEW."pharmacistCheckPolicyVersion" := OLD."pharmacistCheckPolicyVersion";
      NEW."pharmacistCheckAcknowledgement" := OLD."pharmacistCheckAcknowledgement";
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."pharmacistCheckEnabled" IS NULL THEN
    RAISE EXCEPTION 'PHARMACIST_CHECK_POLICY_INVALID' USING ERRCODE = '23514';
  END IF;

  actor := NULLIF(current_setting('app.current_user_id', true), '');
  IF actor IS NULL OR NEW."updatedByUserId" IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'PHARMACIST_CHECK_POLICY_ACTOR_REQUIRED' USING ERRCODE = '23514';
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
    RAISE EXCEPTION 'PHARMACIST_CHECK_POLICY_OWNER_REQUIRED' USING ERRCODE = '42501';
  END IF;

  IF NEW."pharmacistCheckEnabled" = false THEN
    IF NEW."pharmacistCheckAcknowledgement" IS NULL
       OR btrim(NEW."pharmacistCheckAcknowledgement") = '' THEN
      RAISE EXCEPTION 'PHARMACIST_CHECK_DISCLAIMER_REQUIRED' USING ERRCODE = '23514';
    END IF;
  ELSE
    NEW."pharmacistCheckAcknowledgement" := NULL;
  END IF;

  NEW."pharmacistCheckPolicyVersion" :=
    CASE WHEN TG_OP = 'INSERT' THEN last_version ELSE OLD."pharmacistCheckPolicyVersion" END + 1;
  NEW."updatedByUserId" := actor;
  NEW."updatedAt" := CURRENT_TIMESTAMP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pharmacy_owner_policy_pharmacist_check_guard ON "pharmacy_owner_policies";
CREATE TRIGGER pharmacy_owner_policy_pharmacist_check_guard
  BEFORE INSERT OR UPDATE ON "pharmacy_owner_policies"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_owner_policy_pharmacist_check_guard();

-- The allowCashierRxSale and supplier branches are kept exactly as DEV-753 wrote them;
-- only the pharmacist-check branch is new. Its audit row holds the accepted disclaimer.
CREATE OR REPLACE FUNCTION pharmacy_owner_policy_audit_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW."allowCashierRxSale" IS DISTINCT FROM OLD."allowCashierRxSale" THEN
    INSERT INTO "pharmacy_owner_policy_audit" ("organizationId", "setting", "oldValue", "newValue", "actorUserId")
    VALUES (
      NEW."organizationId",
      'allowCashierRxSale',
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."allowCashierRxSale" END,
      NEW."allowCashierRxSale",
      COALESCE(NEW."updatedByUserId", NULLIF(current_setting('app.current_user_id', true), ''))
    );
  END IF;
  IF (TG_OP = 'INSERT' AND NEW."supplierComplianceChecksEnabled" IS DISTINCT FROM true)
     OR (TG_OP = 'UPDATE' AND NEW."supplierComplianceChecksEnabled"
         IS DISTINCT FROM OLD."supplierComplianceChecksEnabled") THEN
    INSERT INTO "pharmacy_owner_policy_audit"
      ("organizationId", "setting", "oldValue", "newValue", "actorUserId", "policyVersion", "acknowledgement")
    VALUES (
      NEW."organizationId",
      'supplierComplianceChecksEnabled',
      -- The effective old value: a missing row meant ON.
      CASE WHEN TG_OP = 'INSERT' THEN true ELSE OLD."supplierComplianceChecksEnabled" END,
      NEW."supplierComplianceChecksEnabled",
      NEW."updatedByUserId",
      NEW."supplierCompliancePolicyVersion",
      NEW."supplierComplianceAcknowledgement"
    );
  END IF;
  IF (TG_OP = 'INSERT' AND NEW."pharmacistCheckEnabled" IS DISTINCT FROM true)
     OR (TG_OP = 'UPDATE' AND NEW."pharmacistCheckEnabled"
         IS DISTINCT FROM OLD."pharmacistCheckEnabled") THEN
    INSERT INTO "pharmacy_owner_policy_audit"
      ("organizationId", "setting", "oldValue", "newValue", "actorUserId", "policyVersion", "acknowledgement")
    VALUES (
      NEW."organizationId",
      'pharmacistCheckEnabled',
      -- The effective old value: a missing row meant ON.
      CASE WHEN TG_OP = 'INSERT' THEN true ELSE OLD."pharmacistCheckEnabled" END,
      NEW."pharmacistCheckEnabled",
      NEW."updatedByUserId",
      NEW."pharmacistCheckPolicyVersion",
      NEW."pharmacistCheckAcknowledgement"
    );
  END IF;
  RETURN NEW;
END $$;

-- The one database reading of the setting: a stored false turns the check off; no row, ON
-- or anything unreadable keeps it on.
CREATE OR REPLACE FUNCTION pharmacy_pharmacist_check_enforced(p_organization_id text) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE enabled boolean;
BEGIN
  SELECT "pharmacistCheckEnabled" INTO enabled
    FROM "pharmacy_owner_policies"
   WHERE "organizationId" = p_organization_id;
  RETURN enabled IS DISTINCT FROM false;
END $$;

-- The controlled register keeps its independent-witness check. Besides the solo
-- restoration (DEV-293), the one other exception is a SALE row, or the stock-backed
-- CORRECTION of a void or return, marked as written while the owner had the pharmacist check
-- switched off; the trigger below proves that marker.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'pharmacy_controlled_register_independent_witness'
      AND conrelid = 'pharmacy_controlled_register_entries'::regclass
      AND pg_catalog.pg_get_constraintdef(oid) NOT LIKE '%pharmacist-check-off:%'
  ) THEN
    ALTER TABLE "pharmacy_controlled_register_entries"
      DROP CONSTRAINT "pharmacy_controlled_register_independent_witness";
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'pharmacy_controlled_register_independent_witness'
      AND conrelid = 'pharmacy_controlled_register_entries'::regclass
  ) THEN
    ALTER TABLE "pharmacy_controlled_register_entries"
      ADD CONSTRAINT "pharmacy_controlled_register_independent_witness"
      CHECK (
        "recordedByUserId" <> "witnessedByUserId"
        OR (
          "entryKind" = 'CORRECTION'
          AND "restorationMovementId" IS NOT NULL
          AND COALESCE("signatureRef", '') LIKE 'solo-pin:%'
        )
        OR (
          COALESCE("signatureRef", '') LIKE 'pharmacist-check-off:%'
          AND (
            "entryKind" = 'SALE'
            OR ("entryKind" = 'CORRECTION' AND "restorationMovementId" IS NOT NULL)
          )
        )
      );
  END IF;
END;
$$;

-- A SALE row still names its patient and either a prescription or a witnessed emergency
-- supply. The one exception is the same marked check-off entry: no patient or prescription
-- was asked for, so the row records the stock that left and who sold it. The other kinds
-- keep their shapes unchanged.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'pharmacy_controlled_register_kind_shape'
      AND conrelid = 'pharmacy_controlled_register_entries'::regclass
      AND pg_catalog.pg_get_constraintdef(oid) NOT LIKE '%pharmacist-check-off:%'
  ) THEN
    ALTER TABLE "pharmacy_controlled_register_entries"
      DROP CONSTRAINT "pharmacy_controlled_register_kind_shape";
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'pharmacy_controlled_register_kind_shape'
      AND conrelid = 'pharmacy_controlled_register_entries'::regclass
  ) THEN
    ALTER TABLE "pharmacy_controlled_register_entries"
      ADD CONSTRAINT "pharmacy_controlled_register_kind_shape" CHECK (
        (
          "entryKind" = 'SALE'
          AND "stockMovementId" IS NOT NULL
          AND "patientId" IS NOT NULL
          AND (
            (
              "emergency" = false
              AND "prescriptionId" IS NOT NULL
              AND "prescriptionLineId" IS NOT NULL
              AND "prescriberId" IS NOT NULL
            )
            OR (
              "emergency" = true
              AND length(btrim(COALESCE("prescriberName", ''))) > 0
            )
          )
        )
        OR (
          "entryKind" = 'SALE'
          AND "stockMovementId" IS NOT NULL
          AND "emergency" = false
          AND COALESCE("signatureRef", '') LIKE 'pharmacist-check-off:%'
        )
        OR (
          "entryKind" = 'PURCHASE'
          AND "stockMovementId" IS NOT NULL
          AND "prescriptionId" IS NULL
          AND length(btrim(COALESCE("counterpartyName", ''))) > 0
        )
        OR (
          "entryKind" = 'CORRECTION'
          AND "correctsEntryId" IS NOT NULL
          AND "stockMovementId" IS NULL
          AND length(btrim(COALESCE("correctionReason", ''))) > 0
        )
      );
  END IF;
END;
$$;

-- A 'pharmacist-check-off:' marker is accepted only on a SALE row or a stock-backed
-- CORRECTION (void or return), only while the stored setting for that organization is off,
-- and only naming the policy version in force.
CREATE OR REPLACE FUNCTION pharmacy_controlled_register_pharmacist_check_off_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE current_version integer;
BEGIN
  IF COALESCE(NEW."signatureRef", '') NOT LIKE 'pharmacist-check-off:%' THEN
    RETURN NEW;
  END IF;
  IF NOT (
       NEW."entryKind" = 'SALE'
       OR (NEW."entryKind" = 'CORRECTION' AND NEW."restorationMovementId" IS NOT NULL)
     )
     OR pharmacy_pharmacist_check_enforced(NEW."organizationId") THEN
    RAISE EXCEPTION 'pharmacist check is not switched off for this pharmacy' USING ERRCODE = '23514';
  END IF;
  SELECT "pharmacistCheckPolicyVersion" INTO current_version
    FROM "pharmacy_owner_policies"
   WHERE "organizationId" = NEW."organizationId";
  IF NEW."signatureRef" IS DISTINCT FROM ('pharmacist-check-off:v' || current_version::text) THEN
    RAISE EXCEPTION 'pharmacist check marker does not match the policy in force' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pharmacy_controlled_register_pharmacist_check_off_guard
  ON "pharmacy_controlled_register_entries";
CREATE TRIGGER pharmacy_controlled_register_pharmacist_check_off_guard
  BEFORE INSERT OR UPDATE ON "pharmacy_controlled_register_entries"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_controlled_register_pharmacist_check_off_guard();

-- A refill cycle keeps its CHECK that a prescription-only cycle past AWAITING_PHARMACIST
-- carries an approval. While the owner has the check off, that approval may be the
-- owner-switched-off marker instead of a pharmacist's; it is accepted only when written while
-- the stored setting is off and only naming the policy version in force.
CREATE OR REPLACE FUNCTION pharmacy_refill_cycle_pharmacist_check_off_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE current_version integer;
BEGIN
  IF COALESCE(NEW."approvalPolicy", '') NOT LIKE 'pharmacist-check-off:%' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW."approvalPolicy" IS NOT DISTINCT FROM OLD."approvalPolicy"
     AND NEW."approvedAt" IS NOT DISTINCT FROM OLD."approvedAt" THEN
    RETURN NEW;
  END IF;
  IF pharmacy_pharmacist_check_enforced(NEW."organizationId") THEN
    RAISE EXCEPTION 'pharmacist check is not switched off for this pharmacy' USING ERRCODE = '23514';
  END IF;
  SELECT "pharmacistCheckPolicyVersion" INTO current_version
    FROM "pharmacy_owner_policies"
   WHERE "organizationId" = NEW."organizationId";
  IF NEW."approvalPolicy" IS DISTINCT FROM ('pharmacist-check-off:v' || current_version::text) THEN
    RAISE EXCEPTION 'pharmacist check marker does not match the policy in force' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pharmacy_refill_cycle_pharmacist_check_off_guard
  ON "pharmacy_refill_subscription_cycles";
CREATE TRIGGER pharmacy_refill_cycle_pharmacist_check_off_guard
  BEFORE INSERT OR UPDATE ON "pharmacy_refill_subscription_cycles"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_refill_cycle_pharmacist_check_off_guard();

-- DEV-73 holds a prescription-only cycle past AWAITING_PHARMACIST to a covering prescription
-- line. That rule is kept; its one exception is a cycle whose approval is the
-- owner-switched-off marker, which the trigger above accepts only while the setting is off.
-- Re-added NOT VALID exactly as DEV-73 added it, so legacy rows are not re-checked.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'pharmacy_refill_cycles_rx_prescription_ck'
      AND conrelid = 'pharmacy_refill_subscription_cycles'::regclass
      AND pg_catalog.pg_get_constraintdef(oid) NOT LIKE '%pharmacist-check-off:%'
  ) THEN
    ALTER TABLE "pharmacy_refill_subscription_cycles"
      DROP CONSTRAINT "pharmacy_refill_cycles_rx_prescription_ck";
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'pharmacy_refill_cycles_rx_prescription_ck'
      AND conrelid = 'pharmacy_refill_subscription_cycles'::regclass
  ) THEN
    ALTER TABLE "pharmacy_refill_subscription_cycles"
      ADD CONSTRAINT "pharmacy_refill_cycles_rx_prescription_ck" CHECK (
        NOT "requiresPharmacist"
        OR "status" IN ('AWAITING_PHARMACIST', 'RELEASED')
        OR "prescriptionLineId" IS NOT NULL
        OR COALESCE("approvalPolicy", '') LIKE 'pharmacist-check-off:%'
      ) NOT VALID;
  END IF;
END;
$$;

COMMIT;
