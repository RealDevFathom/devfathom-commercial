-- A tenant identifier alone is not authority to bypass immutable-history guards.
-- Require the exact tenant plus either the trusted platform transaction context or
-- membership in the optional, deployment-managed purge role.
BEGIN;

CREATE OR REPLACE FUNCTION app_is_verified_tenant_purge(organization_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.purging_organization_id', true), '') = organization_id
    AND (
      current_setting('app.is_platform_admin', true) = 'true'
      OR EXISTS (
        SELECT 1 FROM pg_roles
        WHERE rolname = 'app_tenant_purge'
          AND pg_has_role(current_user, oid, 'MEMBER')
      )
    )
$$;

CREATE OR REPLACE FUNCTION pharmacy_rx_reject_append_only_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND app_is_verified_tenant_purge(OLD."organizationId") THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;

CREATE OR REPLACE FUNCTION pharmacy_rx_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND app_is_verified_tenant_purge(OLD."organizationId") THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;

CREATE OR REPLACE FUNCTION pharmacy_assert_onboarding_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF app_is_verified_tenant_purge(OLD."organizationId") THEN RETURN OLD; END IF;
    IF NOT EXISTS (SELECT 1 FROM "organizations" WHERE "id" = OLD."organizationId") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'pharmacy onboarding events are append-only; delete or purge the organization to remove its onboarding history' USING ERRCODE = 'P0001';
  END IF;
  RAISE EXCEPTION 'pharmacy onboarding events are append-only' USING ERRCODE = 'P0001';
END $$;

CREATE OR REPLACE FUNCTION pharmacy_reject_regulatory_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."effectiveTo" IS NULL AND NEW."effectiveTo" IS NOT NULL
     AND NEW."effectiveTo" > OLD."effectiveFrom"
     AND (to_jsonb(NEW) - 'effectiveTo') = (to_jsonb(OLD) - 'effectiveTo') THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'pharmacy_branch_regulatory_profiles' THEN
    IF app_is_verified_tenant_purge(OLD."organizationId") THEN RETURN OLD; END IF;
    IF NOT EXISTS (SELECT 1 FROM "organizations" WHERE "id" = OLD."organizationId") THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION '% is append-only; create a new effective-dated version', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;

CREATE OR REPLACE FUNCTION camera_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF app_is_verified_tenant_purge(OLD."organizationId") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'camera evidence is retained; retention clears the still, not the row' USING ERRCODE = '23514';
  END IF;
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."branchId" IS DISTINCT FROM OLD."branchId"
     OR NEW."subjectKind" IS DISTINCT FROM OLD."subjectKind"
     OR NEW."subjectId" IS DISTINCT FROM OLD."subjectId"
     OR NEW."saleId" IS DISTINCT FROM OLD."saleId"
     OR NEW."cameraId" IS DISTINCT FROM OLD."cameraId"
     OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt"
     OR NEW."temperatureZoneId" IS DISTINCT FROM OLD."temperatureZoneId"
     OR NEW."readingTemperatureC" IS DISTINCT FROM OLD."readingTemperatureC"
     OR NEW."readingRecordedAt" IS DISTINCT FROM OLD."readingRecordedAt" THEN
    RAISE EXCEPTION 'camera evidence binding is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD."status" = 'PENDING' AND NEW."status" IN ('CAPTURED','FAILED'))
       OR (OLD."status" = 'CAPTURED' AND NEW."status" = 'PURGED'
           AND NEW."capturedAt" = OLD."capturedAt"
           AND NEW."byteLength" IS NOT DISTINCT FROM OLD."byteLength")) THEN
    RAISE EXCEPTION 'camera evidence cannot move from % to %', OLD."status", NEW."status" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION hotel_inventory_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF app_is_verified_tenant_purge(OLD."organizationId") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Inventory status history is append-only and trigger-owned' USING ERRCODE = '23514';
  END IF;
  IF TG_OP <> 'INSERT' OR pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Inventory status history is append-only and trigger-owned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION hotel_inventory_block_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor text := NULLIF(btrim(current_setting('app.current_user_id', true)), '');
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF app_is_verified_tenant_purge(OLD."organizationId") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Release inventory blocks instead of deleting' USING ERRCODE = '23514';
  END IF;
  IF actor IS NULL THEN RAISE EXCEPTION 'Inventory block requires actor' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."releasedAt" IS NOT NULL THEN RAISE EXCEPTION 'New block cannot be released' USING ERRCODE = '23514'; END IF;
    NEW."createdBy" := actor;
    NEW."createdAt" := clock_timestamp();
  ELSE
    IF (to_jsonb(NEW) - ARRAY['releasedAt','releasedBy','releaseReason']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['releasedAt','releasedBy','releaseReason']) OR OLD."releasedAt" IS NOT NULL OR NEW."releasedAt" IS NULL THEN
      RAISE EXCEPTION 'Inventory blocks allow only one attributed release' USING ERRCODE = '23514';
    END IF;
    NEW."releasedBy" := actor;
    NEW."releasedAt" := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION pharmacy_controlled_register_retention_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_ts timestamp(3); retained_until timestamp(3);
BEGIN
  IF app_is_verified_tenant_purge(OLD."organizationId") THEN RETURN OLD; END IF;
  IF NOT EXISTS (SELECT 1 FROM "organizations" WHERE "id" = OLD."organizationId") THEN RETURN OLD; END IF;
  SELECT max("createdAt") INTO last_ts FROM "pharmacy_controlled_register_entries"
    WHERE "organizationId" = OLD."organizationId" AND "branchId" = OLD."branchId";
  retained_until := greatest(OLD."createdAt", COALESCE(last_ts, OLD."createdAt")) + interval '3 years';
  IF now() < retained_until THEN
    RAISE EXCEPTION 'controlled register entry is within its 3-year retention window (until %)', retained_until USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;

COMMIT;
