ALTER TABLE "organizations"
ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "lastDemoResetAt" TIMESTAMP(3);

CREATE INDEX "organizations_isDemo_idx" ON "organizations"("isDemo");

CREATE FUNCTION public.restaurant_demo_reset_allowed(row_organization_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(
    row_organization_id IS NOT NULL
    AND row_organization_id = NULLIF(pg_catalog.current_setting('app.demo_reset_organization_id', true), '')
    AND row_organization_id = NULLIF(pg_catalog.current_setting('app.current_organization_id', true), '')
    AND pg_catalog.current_setting('app.is_platform_admin', true) = 'false'
    AND EXISTS (
      SELECT 1
      FROM public.organizations AS organization
      WHERE organization."id" = row_organization_id
        AND organization."isDemo" = true
        AND organization."vertical" = 'RESTAURANT'::public."OrganizationVertical"
        AND organization."deploymentMode" = 'SHARED'::public."OrganizationDeploymentMode"
    ),
    false
  );
$$;

CREATE OR REPLACE FUNCTION public.reject_tax_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.restaurant_demo_reset_allowed(OLD."organizationId") THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'tax record is immutable' USING ERRCODE = '55000';
END; $$;

CREATE OR REPLACE FUNCTION public.guard_tax_profile_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.restaurant_demo_reset_allowed(OLD."organizationId") THEN RETURN OLD; END IF;
  IF OLD."status" = 'DRAFT' THEN RETURN NEW; END IF;
  IF OLD."status" = 'PUBLISHED'
     AND OLD."effectiveTo" IS NULL AND NEW."effectiveTo" IS NOT NULL
     AND NEW."effectiveTo" > OLD."effectiveFrom"
     AND (to_jsonb(NEW) - 'effectiveTo' - 'updatedAt') = (to_jsonb(OLD) - 'effectiveTo' - 'updatedAt')
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'published tax version is immutable' USING ERRCODE = '55000';
END; $$;

CREATE OR REPLACE FUNCTION public.guard_tax_rule_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.restaurant_demo_reset_allowed(OLD."organizationId") THEN RETURN OLD; END IF;
  IF OLD."status" = 'DRAFT' THEN RETURN NEW; END IF;
  IF OLD."status" = 'PUBLISHED'
     AND OLD."effectiveTo" IS NULL AND NEW."effectiveTo" IS NOT NULL
     AND NEW."effectiveTo" > OLD."effectiveFrom"
     AND (to_jsonb(NEW) - 'effectiveTo' - 'updatedAt') = (to_jsonb(OLD) - 'effectiveTo' - 'updatedAt')
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'published tax version is immutable' USING ERRCODE = '55000';
END; $$;

CREATE OR REPLACE FUNCTION public.prevent_effective_loyalty_program_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.restaurant_demo_reset_allowed(OLD."organizationId") THEN RETURN OLD; END IF;
  IF OLD."effectiveFrom" <= clock_timestamp() THEN
    RAISE EXCEPTION 'effective loyalty program versions are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_promotion_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.restaurant_demo_reset_allowed(OLD."organizationId") THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'promotion evidence is append-only' USING ERRCODE = '55000';
END; $$;

CREATE OR REPLACE FUNCTION public.guard_promotion_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.restaurant_demo_reset_allowed(OLD."organizationId") THEN RETURN OLD; END IF;
  -- Only drafts update or delete. The publish and supersede transitions are the
  -- two exceptions, and each may only move the row FORWARD along the lifecycle.
  IF OLD."status" = 'DRAFT' THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'published promotion version cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'PUBLISHED' AND NEW."status" = 'SUPERSEDED'
     AND NEW."ruleHash" = OLD."ruleHash" AND NEW."versionNumber" = OLD."versionNumber"
     AND NEW."effectiveFrom" = OLD."effectiveFrom" AND NEW."promotionId" = OLD."promotionId"
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'published promotion version is immutable' USING ERRCODE = '55000';
END; $$;

CREATE OR REPLACE FUNCTION public.guard_promotion_component_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status "RestaurantPromotionVersionStatus";
BEGIN
  IF TG_OP = 'DELETE' AND public.restaurant_demo_reset_allowed(OLD."organizationId") THEN RETURN OLD; END IF;
  SELECT v."status" INTO parent_status FROM "restaurant_promotion_versions" v
   WHERE v."organizationId" = OLD."organizationId" AND v."id" = OLD."promotionVersionId";
  -- A vanished parent means the cascade is running; let it through.
  IF NOT FOUND THEN RETURN COALESCE(NEW, OLD); END IF;
  IF parent_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'published promotion rule component is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN COALESCE(NEW, OLD);
END; $$;

CREATE OR REPLACE FUNCTION public.guard_promotion_reservation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.restaurant_demo_reset_allowed(OLD."organizationId") THEN RETURN OLD; END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'promotion cap reservation is append-only' USING ERRCODE = '55000';
  END IF;
  IF OLD."state" <> 'RESERVED' THEN
    RAISE EXCEPTION 'promotion cap reservation is already settled' USING ERRCODE = '55000';
  END IF;
  IF NEW."state" NOT IN ('CONSUMED', 'RELEASED') THEN
    RAISE EXCEPTION 'illegal promotion cap reservation transition' USING ERRCODE = '55000';
  END IF;
  -- Settlement moves the state only; it can never restate the amount it holds.
  IF NEW."counterId" <> OLD."counterId" OR NEW."evaluationId" <> OLD."evaluationId"
     OR NEW."promotionVersionId" <> OLD."promotionVersionId"
     OR NEW."scopeKind" <> OLD."scopeKind" OR NEW."scopeKey" <> OLD."scopeKey"
     OR NEW."applicationOrdinal" <> OLD."applicationOrdinal"
     OR NEW."reservedCount" <> OLD."reservedCount" OR NEW."reservedAmount" <> OLD."reservedAmount"
  THEN
    RAISE EXCEPTION 'promotion cap reservation payload is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.guard_restaurant_money_idempotency_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.restaurant_demo_reset_allowed(OLD."organizationId") THEN RETURN OLD; END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'money idempotency record is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD."resultRef" IS NULL AND OLD."resultPayload" IS NULL AND OLD."completedAt" IS NULL
     AND (to_jsonb(NEW) - ARRAY['resultRef', 'resultPayload', 'completedAt', 'updatedAt'])
         = (to_jsonb(OLD) - ARRAY['resultRef', 'resultPayload', 'completedAt', 'updatedAt'])
     AND (
       (OLD."canonicalPayloadHash" IS NULL AND NEW."resultRef" IS NOT NULL
        AND NEW."resultPayload" IS NULL AND NEW."completedAt" IS NULL)
       OR
       (OLD."canonicalPayloadHash" IS NOT NULL AND NEW."resultRef" IS NOT NULL
        AND NEW."resultPayload" IS NOT NULL AND NEW."completedAt" IS NOT NULL)
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'money idempotency record is immutable' USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_restaurant_service_charge_policy_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP = 'DELETE' AND public.restaurant_demo_reset_allowed(OLD."organizationId") THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE'
     AND OLD."effectiveTo" IS NULL AND NEW."effectiveTo" IS NOT NULL
     AND NEW."effectiveTo" > OLD."effectiveFrom"
     AND (to_jsonb(NEW) - ARRAY['effectiveTo', 'endIdempotencyKey', 'endPayloadHash'])
       = (to_jsonb(OLD) - ARRAY['effectiveTo', 'endIdempotencyKey', 'endPayloadHash']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'restaurant service charge policy versions are immutable';
END $$;

CREATE OR REPLACE FUNCTION public.reject_restaurant_workforce_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.restaurant_demo_reset_allowed(OLD."organizationId") THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'restaurant workforce history is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_restaurant_break_time_observations() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.restaurant_demo_reset_allowed(OLD."organizationId") THEN RETURN OLD; END IF;
  IF TG_OP = 'DELETE' OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt" OR
     (OLD."endedAt" IS NOT NULL AND NEW."endedAt" IS DISTINCT FROM OLD."endedAt") THEN
    RAISE EXCEPTION 'restaurant break time observations are append-only' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_service_charge_policy_versions"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));

CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_promotion_cap_reservations"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));
CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_promotion_evaluation_snapshots"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));
CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_promotion_candidate_snapshots"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));
CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_promotion_application_snapshots"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));
CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_promotion_unit_allocations"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));
CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_promotion_bill_application_snapshots"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));
CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_promotion_audit_events"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));

CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_staff_job_role_audits"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));

CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_shift_swap_requests"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));
CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_shift_swap_decisions"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));
CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_shift_events"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));
CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_time_adjustments"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));
CREATE POLICY "restaurant_demo_reset_delete" ON "restaurant_workforce_commands"
FOR DELETE USING (public.restaurant_demo_reset_allowed("organizationId"));
