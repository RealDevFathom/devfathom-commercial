BEGIN;

-- DEV-96 / SAFE-04 — retention periods are enforced, not only recorded.
--
-- 1. pharmacy_retention_days() resolves the retention period of one record class
--    from the branch's CURRENT jurisdiction rule set ("recordRetentionByClass",
--    and "prescriptionRetentionDays" for prescriptions) and the tenant's latest
--    effective pharmacy_retention_classes row. The longer period wins: a tenant
--    may extend a statutory period, never shorten it.
-- 2. A BEFORE DELETE trigger refuses deleting a prescription, controlled register
--    entry, sale (FISCAL) or audit row while it is inside its retention window.
--    Pharmacy records with no resolvable period are refused outright (fail
--    closed); audit_logs is shared by every vertical, so a row of an organization
--    with no pharmacy retention period is left to the existing rules.
-- 3. The append-only guards on prescriptions and the controlled register admit a
--    DELETE only from the retention purge: transaction-local
--    "app.retention_purge_record" must name exactly this record's root, the
--    platform-admin flag must be set, the root's window must have elapsed and no
--    legal hold may be active. Every other caller still gets "append-only".
--
-- The sanctioned tenant purge ("app.purging_organization_id" with the platform
-- flag) keeps its existing reach; legal holds still refuse it.

CREATE OR REPLACE FUNCTION pharmacy_retention_json_days(value jsonb)
RETURNS integer LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE days numeric;
BEGIN
  IF value IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(value) = 'number' THEN
    days := (value #>> '{}')::numeric;
    IF days IS NULL OR days <= 0 THEN RETURN NULL; END IF;
    -- 1000 years caps a malformed value before it overflows the interval.
    RETURN LEAST(ceil(days), 365000)::integer;
  END IF;
  IF jsonb_typeof(value) = 'object' THEN
    SELECT max(pharmacy_retention_json_days(entry.value)) INTO days FROM jsonb_each(value) AS entry;
    RETURN days::integer;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION pharmacy_retention_days(
  p_organization_id text,
  p_record_class "PharmacyRecordClass",
  p_branch_id text
) RETURNS integer LANGUAGE plpgsql STABLE AS $$
DECLARE
  at_utc timestamp := timezone('UTC', now());
  tenant_days integer;
  rule_days integer;
BEGIN
  SELECT rc."retentionDays" INTO tenant_days
    FROM "pharmacy_retention_classes" rc
   WHERE rc."organizationId" = p_organization_id
     AND rc."recordClass" = p_record_class
     AND rc."effectiveFrom" <= at_utc
   ORDER BY rc."effectiveFrom" DESC, rc."id" DESC
   LIMIT 1;

  -- A branchless record (prescription, audit row) takes the longest period of
  -- any branch the organization currently operates.
  SELECT max(GREATEST(
           pharmacy_retention_json_days(r."recordRetentionByClass" -> 'values' -> (p_record_class::text)),
           CASE WHEN p_record_class = 'PRESCRIPTION'
                THEN pharmacy_retention_json_days(r."prescriptionRetentionDays" -> 'values') END
         ))
    INTO rule_days
    FROM "pharmacy_branch_regulatory_profiles" p
    JOIN "pharmacy_jurisdiction_rule_sets" r ON r."id" = p."jurisdictionRuleSetId"
   WHERE p."organizationId" = p_organization_id
     AND (p_branch_id IS NULL OR p."branchId" = p_branch_id)
     AND p."effectiveFrom" <= at_utc
     AND (p."effectiveTo" IS NULL OR p."effectiveTo" > at_utc);

  RETURN GREATEST(tenant_days, rule_days);
END $$;

-- Same latest-event-per-holdKey rule as pharmacy_safe_refuse_delete_under_hold().
CREATE OR REPLACE FUNCTION pharmacy_retention_active_hold(
  p_record_class "PharmacyRecordClass",
  p_organization_id text,
  p_record_id text
) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT e."holdKey"
    FROM "pharmacy_legal_hold_events" e
   WHERE e."organizationId" = p_organization_id AND e."recordClass" = p_record_class
     AND e."recordId" = p_record_id AND e."kind" = 'PLACED'
     AND e."kind" = (SELECT latest."kind" FROM "pharmacy_legal_hold_events" latest
                      WHERE latest."organizationId" = e."organizationId" AND latest."holdKey" = e."holdKey"
                        AND latest."recordClass" = e."recordClass" AND latest."recordId" = e."recordId"
                      ORDER BY latest."createdAt" DESC, latest."id" DESC LIMIT 1)
   ORDER BY e."holdKey"
   LIMIT 1
$$;

-- The instant a record leaves its retention window; NULL when the record is
-- missing or no period is configured for it.
CREATE OR REPLACE FUNCTION pharmacy_retention_window_ends(
  p_record_class "PharmacyRecordClass",
  p_organization_id text,
  p_record_id text
) RETURNS timestamp LANGUAGE plpgsql STABLE AS $$
DECLARE anchor timestamp; branch text; days integer;
BEGIN
  IF p_record_class = 'PRESCRIPTION' THEN
    SELECT x."capturedAt", NULL INTO anchor, branch FROM "pharmacy_prescriptions" x
     WHERE x."organizationId" = p_organization_id AND x."id" = p_record_id;
  ELSIF p_record_class = 'CONTROLLED_REGISTER' THEN
    SELECT x."createdAt", x."branchId" INTO anchor, branch FROM "pharmacy_controlled_register_entries" x
     WHERE x."organizationId" = p_organization_id AND x."id" = p_record_id;
  ELSIF p_record_class = 'FISCAL' THEN
    SELECT COALESCE(x."completedAt", x."createdAt"), x."branchId" INTO anchor, branch FROM "pharmacy_sales" x
     WHERE x."organizationId" = p_organization_id AND x."id" = p_record_id;
  ELSE
    SELECT x."createdAt", NULL INTO anchor, branch FROM "audit_logs" x
     WHERE x."organizationId" = p_organization_id AND x."id" = p_record_id;
  END IF;
  IF anchor IS NULL THEN RETURN NULL; END IF;
  days := pharmacy_retention_days(p_organization_id, p_record_class, branch);
  IF days IS NULL THEN RETURN NULL; END IF;
  RETURN anchor + make_interval(days => days);
END $$;

CREATE OR REPLACE FUNCTION pharmacy_retention_refuse_early_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE record_class "PharmacyRecordClass"; anchor timestamp; branch text; days integer;
BEGIN
  -- The sanctioned purge of this row's own tenant.
  IF NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId"
     AND current_setting('app.is_platform_admin', true) = 'true' THEN
    RETURN OLD;
  END IF;

  IF TG_TABLE_NAME = 'pharmacy_prescriptions' THEN
    record_class := 'PRESCRIPTION'; anchor := OLD."capturedAt";
  ELSIF TG_TABLE_NAME = 'pharmacy_controlled_register_entries' THEN
    record_class := 'CONTROLLED_REGISTER'; anchor := OLD."createdAt"; branch := OLD."branchId";
  ELSIF TG_TABLE_NAME = 'pharmacy_sales' THEN
    record_class := 'FISCAL'; anchor := COALESCE(OLD."completedAt", OLD."createdAt"); branch := OLD."branchId";
  ELSE
    record_class := 'AUDIT'; anchor := OLD."createdAt";
  END IF;

  days := pharmacy_retention_days(OLD."organizationId", record_class, branch);
  IF days IS NULL THEN
    IF record_class = 'AUDIT' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'deletion refused: no retention period is configured for % records', record_class
      USING ERRCODE = '55000';
  END IF;
  IF anchor + make_interval(days => days) > timezone('UTC', now()) THEN
    RAISE EXCEPTION 'deletion refused: % record % is inside its % day retention window until %',
      record_class, OLD."id", days, anchor + make_interval(days => days)
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS ab_pharmacy_prescriptions_retention_window ON "pharmacy_prescriptions";
CREATE TRIGGER ab_pharmacy_prescriptions_retention_window BEFORE DELETE ON "pharmacy_prescriptions"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_retention_refuse_early_delete();
DROP TRIGGER IF EXISTS ab_pharmacy_controlled_register_retention_window ON "pharmacy_controlled_register_entries";
CREATE TRIGGER ab_pharmacy_controlled_register_retention_window BEFORE DELETE ON "pharmacy_controlled_register_entries"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_retention_refuse_early_delete();
DROP TRIGGER IF EXISTS ab_pharmacy_sales_retention_window ON "pharmacy_sales";
CREATE TRIGGER ab_pharmacy_sales_retention_window BEFORE DELETE ON "pharmacy_sales"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_retention_refuse_early_delete();
DROP TRIGGER IF EXISTS ab_pharmacy_audit_retention_window ON "audit_logs";
CREATE TRIGGER ab_pharmacy_audit_retention_window BEFORE DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_retention_refuse_early_delete();

-- Whether this DELETE is the retention purge of an expired, unheld record.
CREATE OR REPLACE FUNCTION pharmacy_retention_purge_authorised(p_table text, p_old jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE
  target text := NULLIF(current_setting('app.retention_purge_record', true), '');
  organization_id text := p_old ->> 'organizationId';
  record_class "PharmacyRecordClass";
  root_id text;
  ends timestamp;
BEGIN
  IF target IS NULL OR current_setting('app.is_platform_admin', true) IS DISTINCT FROM 'true' THEN
    RETURN false;
  END IF;
  IF p_table = 'pharmacy_prescriptions' THEN
    record_class := 'PRESCRIPTION'; root_id := p_old ->> 'id';
  ELSIF p_table = 'pharmacy_prescription_lines' THEN
    record_class := 'PRESCRIPTION'; root_id := p_old ->> 'prescriptionId';
  ELSIF p_table = 'pharmacy_prescription_fills' THEN
    record_class := 'PRESCRIPTION';
    SELECT l."prescriptionId" INTO root_id FROM "pharmacy_prescription_lines" l
     WHERE l."organizationId" = organization_id AND l."id" = p_old ->> 'prescriptionLineId';
  ELSIF p_table = 'pharmacy_controlled_register_entries' THEN
    record_class := 'CONTROLLED_REGISTER'; root_id := p_old ->> 'id';
  ELSE
    RETURN false;
  END IF;
  IF root_id IS NULL OR target IS DISTINCT FROM organization_id || ':' || record_class::text || ':' || root_id THEN
    RETURN false;
  END IF;
  -- A register entry's running balance continues from the highest surviving
  -- serial of its medicine/lot chain, and the next serial from the branch's
  -- highest. Only the OLDEST surviving entry of a chain that has a newer entry
  -- may go, so the survivors are always the newest contiguous suffix: the latest
  -- balance and the branch's top serial are never removed.
  IF p_table = 'pharmacy_controlled_register_entries' AND (
       NOT EXISTS (SELECT 1 FROM "pharmacy_controlled_register_entries" later
                    WHERE later."organizationId" = organization_id
                      AND later."branchId" = p_old ->> 'branchId'
                      AND later."medicineId" IS NOT DISTINCT FROM p_old ->> 'medicineId'
                      AND later."inventoryLotId" = p_old ->> 'inventoryLotId'
                      AND later."serial" > (p_old ->> 'serial')::integer)
       OR EXISTS (SELECT 1 FROM "pharmacy_controlled_register_entries" earlier
                   WHERE earlier."organizationId" = organization_id
                     AND earlier."branchId" = p_old ->> 'branchId'
                     AND earlier."medicineId" IS NOT DISTINCT FROM p_old ->> 'medicineId'
                     AND earlier."inventoryLotId" = p_old ->> 'inventoryLotId'
                     AND earlier."serial" < (p_old ->> 'serial')::integer)
     ) THEN
    RETURN false;
  END IF;
  ends := pharmacy_retention_window_ends(record_class, organization_id, root_id);
  RETURN ends IS NOT NULL
     AND ends <= timezone('UTC', now())
     AND pharmacy_retention_active_hold(record_class, organization_id, root_id) IS NULL;
END $$;

CREATE OR REPLACE FUNCTION pharmacy_rx_reject_append_only_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pharmacy_retention_purge_authorised(TG_TABLE_NAME, to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;

CREATE OR REPLACE FUNCTION pharmacy_rx_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pharmacy_retention_purge_authorised(TG_TABLE_NAME, to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;

COMMIT;
