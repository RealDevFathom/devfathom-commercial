-- DEV-96. No retention duration is seeded here. Confirmed jurisdiction JSON is
-- {"values":{"PRESCRIPTION":days,"CONTROLLED_REGISTER":days,"FISCAL":days,"AUDIT":days},
--  "provisional":false}. Rx additionally requires confirmed, nonempty
-- prescriptionRetentionDays.values; without a persisted Rx classification we
-- use its largest positive integer value. Tenant rules can only lengthen it.
-- Existing append-only/controlled/fiscal guards remain in force after expiry.

-- Updating one row serializes policy/hold changes with deletion. Unlike an
-- advisory lock, this also aborts a stale repeatable-read/serializable snapshot.
CREATE TABLE "pharmacy_retention_mutex" (
  "singleton" boolean PRIMARY KEY CHECK ("singleton"),
  "version" boolean NOT NULL
);
INSERT INTO "pharmacy_retention_mutex" VALUES (true, false);
REVOKE ALL ON TABLE "pharmacy_retention_mutex" FROM PUBLIC;

CREATE FUNCTION pharmacy_lock_retention() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public."pharmacy_retention_mutex" SET "version" = NOT "version" WHERE "singleton";
  IF NOT FOUND THEN RAISE EXCEPTION 'retention synchronization is unavailable' USING ERRCODE='55000'; END IF;
END $$;

CREATE FUNCTION pharmacy_retention_lock_statement() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.pharmacy_lock_retention();
  RETURN NULL;
END $$;

CREATE FUNCTION pharmacy_record_retention_deadline(
  organization_id text, record_class text, record_id text, expected_branch_id text DEFAULT NULL
) RETURNS timestamp
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  recorded_at timestamp;
  record_branch text;
  branch record;
  profile record;
  rules record;
  days numeric := 0;
  class_days numeric;
  rx_value jsonb;
  tenant_days integer;
  branches_seen integer := 0;
BEGIN
  PERFORM public.pharmacy_lock_retention();
  IF organization_id IS NULL OR btrim(organization_id) = '' OR record_id IS NULL OR btrim(record_id) = '' THEN
    RAISE EXCEPTION 'retention requires an explicit tenant and record' USING ERRCODE='55000';
  END IF;
  CASE record_class
    WHEN 'PRESCRIPTION' THEN
      SELECT "capturedAt" INTO recorded_at FROM public."pharmacy_prescriptions"
        WHERE "organizationId" = organization_id AND "id" = record_id;
    WHEN 'CONTROLLED_REGISTER' THEN
      SELECT "createdAt", "branchId" INTO recorded_at, record_branch FROM public."pharmacy_controlled_register_entries"
        WHERE "organizationId" = organization_id AND "id" = record_id;
    WHEN 'FISCAL' THEN
      SELECT "createdAt", "branchId" INTO recorded_at, record_branch FROM public."pharmacy_sales"
        WHERE "organizationId" = organization_id AND "id" = record_id;
    WHEN 'AUDIT' THEN
      SELECT "createdAt" INTO recorded_at FROM public."audit_logs"
        WHERE "organizationId" = organization_id AND "id" = record_id;
    ELSE RAISE EXCEPTION 'unknown pharmacy record class' USING ERRCODE='55000';
  END CASE;
  IF recorded_at IS NULL OR NOT isfinite(recorded_at) THEN
    RAISE EXCEPTION 'retention record is missing or outside tenant scope' USING ERRCODE='55000';
  END IF;
  IF expected_branch_id IS NOT NULL AND record_branch IS DISTINCT FROM expected_branch_id THEN
    RAISE EXCEPTION 'retention record is outside branch scope' USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT DISTINCT ON ("holdKey") "kind" FROM public."pharmacy_legal_hold_events"
      WHERE "organizationId" = organization_id AND "recordClass"::text = record_class AND "recordId" = record_id
      ORDER BY "holdKey", "createdAt" DESC, "id" DESC
    ) latest WHERE latest."kind"::text = 'PLACED'
  ) THEN RAISE EXCEPTION 'deletion refused: record is protected by legal hold' USING ERRCODE='55000'; END IF;

  -- Rx and audit rows have no branch column. Require every historical branch's
  -- policy and take the longest. Current branch/profile RLS is tenant-wide.
  FOR branch IN SELECT "id" FROM public."pharmacy_branches"
      WHERE "organizationId" = organization_id
        AND ((record_branch IS NOT NULL AND "id" = record_branch)
          OR (record_branch IS NULL AND "createdAt" <= recorded_at))
  LOOP
    branches_seen := branches_seen + 1;
    SELECT p.*, r."code" INTO profile
      FROM public."pharmacy_branch_regulatory_profiles" p
      JOIN public."pharmacy_jurisdiction_rule_sets" r ON r."id" = p."jurisdictionRuleSetId"
      WHERE p."organizationId" = organization_id AND p."branchId" = branch."id"
        AND p."effectiveFrom" <= recorded_at AND (p."effectiveTo" IS NULL OR recorded_at < p."effectiveTo")
      ORDER BY p."effectiveFrom" DESC, p."version" DESC, p."id" DESC LIMIT 1;
    IF NOT FOUND OR profile."isPlaceholder" THEN
      RAISE EXCEPTION 'retention requires a confirmed effective branch profile' USING ERRCODE='55000';
    END IF;
    SELECT * INTO rules FROM public."pharmacy_jurisdiction_rule_sets"
      WHERE "code" = profile."code" AND "effectiveFrom" <= recorded_at
        AND ("effectiveTo" IS NULL OR recorded_at < "effectiveTo")
      ORDER BY "effectiveFrom" DESC, "version" DESC, "id" DESC LIMIT 1;
    IF NOT FOUND OR rules."isPlaceholder"
       OR rules."recordRetentionByClass"->'provisional' IS DISTINCT FROM 'false'::jsonb
       OR jsonb_typeof(rules."recordRetentionByClass"->'values'->record_class) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'retention requires a confirmed jurisdiction record-class policy' USING ERRCODE='55000';
    END IF;
    class_days := (rules."recordRetentionByClass"->'values'->>record_class)::numeric;
    IF class_days <= 0 OR class_days <> trunc(class_days) OR class_days > 2147483647 THEN
      RAISE EXCEPTION 'retention policy days must be a positive integer' USING ERRCODE='55000';
    END IF;
    days := greatest(days, class_days);
    IF record_class = 'PRESCRIPTION' THEN
      IF rules."prescriptionRetentionDays"->'provisional' IS DISTINCT FROM 'false'::jsonb
         OR jsonb_typeof(rules."prescriptionRetentionDays"->'values') IS DISTINCT FROM 'object'
         OR rules."prescriptionRetentionDays"->'values' = '{}'::jsonb THEN
        RAISE EXCEPTION 'retention requires a confirmed prescription policy' USING ERRCODE='55000';
      END IF;
      FOR rx_value IN SELECT value FROM jsonb_each(rules."prescriptionRetentionDays"->'values') LOOP
        IF jsonb_typeof(rx_value) IS DISTINCT FROM 'number' THEN
          RAISE EXCEPTION 'prescription retention days must be a positive integer' USING ERRCODE='55000';
        END IF;
        class_days := rx_value::text::numeric;
        IF class_days <= 0 OR class_days <> trunc(class_days) OR class_days > 2147483647 THEN
          RAISE EXCEPTION 'prescription retention days must be a positive integer' USING ERRCODE='55000';
        END IF;
        days := greatest(days, class_days);
      END LOOP;
    END IF;
  END LOOP;
  IF branches_seen = 0 THEN
    RAISE EXCEPTION 'retention requires a historical pharmacy branch' USING ERRCODE='55000';
  END IF;
  SELECT "retentionDays" INTO tenant_days FROM public."pharmacy_retention_classes"
    WHERE "organizationId" = organization_id AND "recordClass"::text = record_class AND "effectiveFrom" <= recorded_at
    ORDER BY "effectiveFrom" DESC, "id" DESC LIMIT 1;
  IF FOUND THEN
    IF tenant_days IS NULL OR tenant_days <= 0 THEN
      RAISE EXCEPTION 'tenant retention policy is invalid' USING ERRCODE='55000';
    END IF;
    days := greatest(days, tenant_days);
  END IF;
  BEGIN
    RETURN recorded_at + make_interval(days => days::integer);
  EXCEPTION WHEN datetime_field_overflow THEN
    RAISE EXCEPTION 'retention deadline is outside the supported timestamp range' USING ERRCODE='55000';
  END;
END $$;

CREATE FUNCTION pharmacy_record_retention_status(
  organization_id text, record_class text, record_id text, expected_branch_id text DEFAULT NULL
) RETURNS TABLE ("retentionUntil" timestamp, "checkedAt" timestamp, "blockedReason" text)
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  -- Keep the mutex outside the exception subtransaction so a blocked candidate
  -- cannot release synchronization acquired by this assessment.
  PERFORM public.pharmacy_lock_retention();
  BEGIN
    "retentionUntil" := public.pharmacy_record_retention_deadline(organization_id, record_class, record_id, expected_branch_id);
  EXCEPTION WHEN SQLSTATE '55000' THEN
    "blockedReason" := SQLERRM;
  END;
  "checkedAt" := clock_timestamp() AT TIME ZONE 'UTC';
  RETURN NEXT;
END $$;

CREATE FUNCTION pharmacy_retention_record_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE class_name text; deadline timestamp;
BEGIN
  class_name := TG_ARGV[0];
  IF class_name = 'AUDIT' THEN
    IF NOT EXISTS (SELECT 1 FROM public."organizations" WHERE "id" = OLD."organizationId") THEN
      RAISE EXCEPTION 'audit retention tenant scope is missing' USING ERRCODE='55000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public."organizations" WHERE "id" = OLD."organizationId" AND "vertical"::text = 'PHARMACY')
       AND NOT EXISTS (SELECT 1 FROM public."pharmacy_branches" WHERE "organizationId" = OLD."organizationId")
       AND NOT EXISTS (SELECT 1 FROM public."pharmacy_branch_regulatory_profiles" WHERE "organizationId" = OLD."organizationId")
       AND NOT EXISTS (SELECT 1 FROM public."pharmacy_prescriptions" WHERE "organizationId" = OLD."organizationId") THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW)->'id', to_jsonb(NEW)->'organizationId', to_jsonb(NEW)->'branchId',
        to_jsonb(NEW)->'createdAt', to_jsonb(NEW)->'capturedAt') IS DISTINCT FROM
       (to_jsonb(OLD)->'id', to_jsonb(OLD)->'organizationId', to_jsonb(OLD)->'branchId',
        to_jsonb(OLD)->'createdAt', to_jsonb(OLD)->'capturedAt') THEN
      RAISE EXCEPTION 'retention identity, scope and creation time are immutable' USING ERRCODE='55000';
    END IF;
    IF TG_TABLE_NAME = 'pharmacy_sales' THEN
      IF OLD."status"::text <> 'OPEN' AND NEW."status"::text = 'OPEN' THEN
        RAISE EXCEPTION 'completed fiscal records cannot return to an open cart' USING ERRCODE='55000';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  deadline := public.pharmacy_record_retention_deadline(OLD."organizationId", class_name, OLD."id");
  IF (clock_timestamp() AT TIME ZONE 'UTC') < deadline THEN
    RAISE EXCEPTION 'deletion refused: retained until % UTC', deadline USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END $$;

CREATE FUNCTION pharmacy_retention_scope_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE tenant_id text;
BEGIN
  tenant_id := CASE WHEN TG_TABLE_NAME = 'organizations' THEN OLD."id" ELSE to_jsonb(OLD)->>'organizationId' END;
  IF TG_TABLE_NAME = 'organizations' THEN
    IF OLD."vertical"::text <> 'PHARMACY'
       AND NOT EXISTS (SELECT 1 FROM public."pharmacy_branches" WHERE "organizationId" = tenant_id)
       AND NOT EXISTS (SELECT 1 FROM public."pharmacy_branch_regulatory_profiles" WHERE "organizationId" = tenant_id)
       AND NOT EXISTS (SELECT 1 FROM public."pharmacy_prescriptions" WHERE "organizationId" = tenant_id) THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'organizations' THEN
      IF NEW."id" = OLD."id" AND NEW."vertical" = OLD."vertical" THEN RETURN NEW; END IF;
    ELSIF (NEW."id", NEW."organizationId", NEW."createdAt") IS NOT DISTINCT FROM
          (OLD."id", OLD."organizationId", OLD."createdAt") THEN RETURN NEW;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public."pharmacy_prescriptions" WHERE "organizationId" = tenant_id)
     OR EXISTS (SELECT 1 FROM public."audit_logs" WHERE "organizationId" = tenant_id) THEN
    RAISE EXCEPTION 'retention scope cannot change while prescription or audit records remain' USING ERRCODE='55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

CREATE FUNCTION pharmacy_retention_fiscal_child_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE old_data jsonb := to_jsonb(OLD); sale_id text; sale_status text; deadline timestamp;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW)->'id', to_jsonb(NEW)->'organizationId', to_jsonb(NEW)->'branchId',
        to_jsonb(NEW)->'saleId', to_jsonb(NEW)->'saleLineId', to_jsonb(NEW)->'originalSaleId',
        to_jsonb(NEW)->'returnId', to_jsonb(NEW)->'createdAt') IS DISTINCT FROM
       (old_data->'id', old_data->'organizationId', old_data->'branchId', old_data->'saleId',
        old_data->'saleLineId', old_data->'originalSaleId', old_data->'returnId', old_data->'createdAt') THEN
      RAISE EXCEPTION 'fiscal retention aggregate linkage is immutable' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  sale_id := coalesce(old_data->>'saleId', old_data->>'originalSaleId');
  IF sale_id IS NULL AND old_data->>'saleLineId' IS NOT NULL THEN
    SELECT "saleId" INTO sale_id FROM public."pharmacy_sale_lines"
      WHERE "organizationId" = OLD."organizationId" AND "id" = old_data->>'saleLineId';
  END IF;
  SELECT "status"::text INTO sale_status FROM public."pharmacy_sales"
    WHERE "organizationId" = OLD."organizationId" AND "branchId" = OLD."branchId" AND "id" = sale_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fiscal retention aggregate is missing or outside scope' USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT DISTINCT ON ("holdKey") "kind" FROM public."pharmacy_legal_hold_events"
      WHERE "organizationId" = OLD."organizationId" AND "recordClass"::text = 'FISCAL' AND "recordId" = sale_id
      ORDER BY "holdKey", "createdAt" DESC, "id" DESC
    ) latest WHERE latest."kind"::text = 'PLACED'
  ) THEN RAISE EXCEPTION 'deletion refused: record is protected by legal hold' USING ERRCODE='55000'; END IF;
  -- Open carts are editable; the root guard forbids reopening historical sales.
  IF sale_status = 'OPEN' THEN RETURN OLD; END IF;
  deadline := public.pharmacy_record_retention_deadline(OLD."organizationId", 'FISCAL', sale_id, OLD."branchId");
  IF (clock_timestamp() AT TIME ZONE 'UTC') < deadline THEN
    RAISE EXCEPTION 'deletion refused: retained until % UTC', deadline USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END $$;

CREATE FUNCTION pharmacy_retention_refuse_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'retention-protected tables cannot be truncated' USING ERRCODE='55000'; END $$;

DO $$ DECLARE t text; class_name text; BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_jurisdiction_rule_sets','pharmacy_branch_regulatory_profiles',
    'pharmacy_retention_classes','pharmacy_legal_hold_events','pharmacy_branches'] LOOP
    EXECUTE format('CREATE TRIGGER aa_retention_serialize BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.pharmacy_retention_lock_statement()', t);
  END LOOP;
  FOR t, class_name IN SELECT * FROM (VALUES
    ('pharmacy_prescriptions','PRESCRIPTION'), ('pharmacy_controlled_register_entries','CONTROLLED_REGISTER'),
    ('pharmacy_sales','FISCAL'), ('audit_logs','AUDIT')) x(table_name, record_class) LOOP
    EXECUTE format('CREATE TRIGGER aa_retention_serialize BEFORE UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.pharmacy_retention_lock_statement()', t);
    EXECUTE format('CREATE TRIGGER ab_retention_record BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.pharmacy_retention_record_guard(%L)', t, class_name);
  END LOOP;
  CREATE TRIGGER aa_retention_serialize BEFORE UPDATE OF "id", "vertical" OR DELETE ON public."organizations"
    FOR EACH STATEMENT EXECUTE FUNCTION public.pharmacy_retention_lock_statement();
  CREATE TRIGGER ab_retention_scope BEFORE UPDATE OR DELETE ON public."pharmacy_branches"
    FOR EACH ROW EXECUTE FUNCTION public.pharmacy_retention_scope_guard();
  CREATE TRIGGER ab_retention_scope BEFORE UPDATE OF "id", "vertical" OR DELETE ON public."organizations"
    FOR EACH ROW EXECUTE FUNCTION public.pharmacy_retention_scope_guard();
  CREATE TRIGGER ab_retention_record BEFORE UPDATE ON public."pharmacy_fiscal_documents"
    FOR EACH ROW EXECUTE FUNCTION public.pharmacy_retention_record_guard('FISCAL');
  FOREACH t IN ARRAY ARRAY['pharmacy_sale_lines','pharmacy_sale_line_allocations','pharmacy_sale_events',
    'pharmacy_sale_returns','pharmacy_sale_return_lines','pharmacy_tenders','pharmacy_refunds'] LOOP
    EXECUTE format('CREATE TRIGGER aa_retention_serialize BEFORE UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.pharmacy_retention_lock_statement()', t);
    EXECUTE format('CREATE TRIGGER ab_retention_aggregate BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.pharmacy_retention_fiscal_child_guard()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['pharmacy_prescriptions','pharmacy_prescription_lines','pharmacy_prescription_fills',
    'pharmacy_controlled_register_entries','pharmacy_sales','pharmacy_sale_lines','pharmacy_sale_line_allocations',
    'pharmacy_sale_events','pharmacy_sale_returns','pharmacy_sale_return_lines','pharmacy_tenders','pharmacy_refunds',
    'pharmacy_fiscal_documents','pharmacy_fiscal_document_events','audit_logs','pharmacy_retention_classes',
    'pharmacy_legal_hold_events','pharmacy_branch_regulatory_profiles','pharmacy_jurisdiction_rule_sets','pharmacy_branches'] LOOP
    EXECUTE format('CREATE TRIGGER aa_retention_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.pharmacy_retention_refuse_truncate()', t);
  END LOOP;
END $$;
