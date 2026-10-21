-- Purge guards also require the platform control plane.
--
-- Five append-only guards admit a DELETE when "app.purging_organization_id"
-- names the row's tenant: the pharmacy onboarding history, the branch
-- regulatory profiles, camera evidence, and the hospitality inventory status
-- ledger and blocks. The retention worker names the tenant inside its purge
-- transaction, and that transaction is `withPlatformDb`'s (src/lib/platform/
-- jobs.ts: executeJob -> purgeData), which sets "app.is_platform_admin" to
-- 'true' for the same transaction. The guards checked the name alone, so a
-- tenant-runtime transaction (`withTenantDb` sets "app.is_platform_admin" to
-- 'false') that named its own organization could delete its own append-only
-- history: row-level security admits a tenant's own rows.
--
-- Each function is replaced by its latest definition, byte for byte, except
-- that the purge clause also requires "app.is_platform_admin" = 'true', the
-- signal the tenant-isolation policies already trust for the control plane.
-- The ON DELETE CASCADE path (the organization row already gone) and every
-- UPDATE rule are unchanged. CREATE OR REPLACE keeps each function's owner,
-- grants and trigger bindings; no trigger is re-created.
--
-- It sorts after the last hospitality migration (20261021104000) and before
-- 20261021105000-20261021109900, which status.md reserves for hospitality
-- corrections: a later correction to either hospitality guard redefined here
-- applies after this file on a fresh database and on an upgraded one alike.

-- pharmacy_assert_onboarding_event_append_only: latest definition in 20260903120000_pharmacy_onboarding_tenant_deletion.
CREATE OR REPLACE FUNCTION pharmacy_assert_onboarding_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The sanctioned purge of this row's own tenant.
    IF NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId"
       AND current_setting('app.is_platform_admin', true) = 'true' THEN
      RETURN OLD;
    END IF;
    -- The declared ON DELETE CASCADE: the organization row is already gone.
    IF NOT EXISTS (SELECT 1 FROM "organizations" WHERE "id" = OLD."organizationId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'pharmacy onboarding events are append-only; delete or purge the organization to remove its onboarding history'
      USING ERRCODE = 'P0001';
  END IF;

  RAISE EXCEPTION 'pharmacy onboarding events are append-only' USING ERRCODE = 'P0001';
END $$;

-- pharmacy_reject_regulatory_rewrite: latest definition in 20260905080000_pharmacy_regulatory_profile_tenant_purge.
CREATE OR REPLACE FUNCTION pharmacy_reject_regulatory_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."effectiveTo" IS NULL
     AND NEW."effectiveTo" IS NOT NULL
     AND NEW."effectiveTo" > OLD."effectiveFrom"
     AND (to_jsonb(NEW) - 'effectiveTo') = (to_jsonb(OLD) - 'effectiveTo') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'pharmacy_branch_regulatory_profiles' THEN
    IF NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId"
       AND current_setting('app.is_platform_admin', true) = 'true' THEN
      RETURN OLD;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "organizations" WHERE "id" = OLD."organizationId") THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION '% is append-only; create a new effective-dated version', TG_TABLE_NAME
    USING ERRCODE = '23514';
END $$;

-- camera_evidence_guard: latest definition in 20261002120000_camera_preset_coldchain_evidence.
CREATE OR REPLACE FUNCTION camera_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId"
       AND current_setting('app.is_platform_admin', true) = 'true' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'camera evidence is retained; retention clears the still, not the row'
      USING ERRCODE = '23514';
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

  IF NOT (
       (OLD."status" = 'PENDING' AND NEW."status" IN ('CAPTURED', 'FAILED'))
    OR (OLD."status" = 'CAPTURED' AND NEW."status" = 'PURGED'
        AND NEW."capturedAt" = OLD."capturedAt"
        AND NEW."byteLength" IS NOT DISTINCT FROM OLD."byteLength")
  ) THEN
    RAISE EXCEPTION 'camera evidence cannot move from % to %', OLD."status", NEW."status"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- hotel_inventory_event_guard: latest definition in 20261021100000_hospitality_inventory.
CREATE OR REPLACE FUNCTION hotel_inventory_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId"
       AND current_setting('app.is_platform_admin', true) = 'true' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Inventory status history is append-only and trigger-owned' USING ERRCODE = '23514';
  END IF;
  IF TG_OP <> 'INSERT' OR pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Inventory status history is append-only and trigger-owned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- hotel_inventory_block_guard: latest definition in 20261021100000_hospitality_inventory.
CREATE OR REPLACE FUNCTION hotel_inventory_block_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor text := NULLIF(btrim(current_setting('app.current_user_id', true)), '');
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId"
       AND current_setting('app.is_platform_admin', true) = 'true' THEN
      RETURN OLD;
    END IF;
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
