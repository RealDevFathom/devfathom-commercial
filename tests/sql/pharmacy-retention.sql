-- DEV-96 focused migration fixture. Run only in an empty disposable cluster/database:
-- psql -X -v ON_ERROR_STOP=1 -f tests/sql/pharmacy-retention.sql "$DISPOSABLE_DATABASE_URL"
\set ON_ERROR_STOP on
CREATE TABLE organizations (id text PRIMARY KEY, vertical text NOT NULL);
CREATE TABLE pharmacy_branches (id text PRIMARY KEY, "organizationId" text, "createdAt" timestamp, active boolean DEFAULT true);
CREATE TABLE pharmacy_jurisdiction_rule_sets (id text PRIMARY KEY, code text, version integer, "effectiveFrom" timestamp, "effectiveTo" timestamp, "isPlaceholder" boolean DEFAULT false, "recordRetentionByClass" jsonb, "prescriptionRetentionDays" jsonb);
CREATE TABLE pharmacy_branch_regulatory_profiles (id text PRIMARY KEY, "organizationId" text, "branchId" text, version integer, "effectiveFrom" timestamp, "effectiveTo" timestamp, "isPlaceholder" boolean DEFAULT false, "jurisdictionRuleSetId" text);
CREATE TABLE pharmacy_retention_classes (id text PRIMARY KEY, "organizationId" text, "recordClass" text, "retentionDays" integer, "effectiveFrom" timestamp);
CREATE TABLE pharmacy_legal_hold_events (id text PRIMARY KEY, "organizationId" text, "recordClass" text, "recordId" text, "holdKey" text, kind text, "createdAt" timestamp);
CREATE TABLE pharmacy_prescriptions (id text PRIMARY KEY, "organizationId" text, "capturedAt" timestamp);
CREATE TABLE pharmacy_controlled_register_entries (id text PRIMARY KEY, "organizationId" text, "branchId" text, "createdAt" timestamp);
CREATE TABLE pharmacy_sales (id text PRIMARY KEY, "organizationId" text, "branchId" text, "createdAt" timestamp, status text);
CREATE TABLE audit_logs (id text PRIMARY KEY, "organizationId" text, "createdAt" timestamp, "actorId" text);
CREATE TABLE pharmacy_prescription_lines (id text PRIMARY KEY);
CREATE TABLE pharmacy_prescription_fills (id text PRIMARY KEY);
CREATE TABLE pharmacy_fiscal_documents (id text PRIMARY KEY, "organizationId" text, "branchId" text, "createdAt" timestamp);
CREATE TABLE pharmacy_fiscal_document_events (id text PRIMARY KEY);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_sale_lines','pharmacy_sale_line_allocations','pharmacy_sale_events','pharmacy_sale_returns','pharmacy_sale_return_lines','pharmacy_tenders','pharmacy_refunds'] LOOP
    EXECUTE format('CREATE TABLE %I (id text PRIMARY KEY, "organizationId" text, "branchId" text, "saleId" text, "saleLineId" text, "originalSaleId" text, "returnId" text, "createdAt" timestamp)', t);
  END LOOP;
END $$;
-- An existing immutable guard must remain stronger than expiry eligibility.
CREATE FUNCTION fixture_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'legacy append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER pharmacy_prescription_append_only BEFORE UPDATE OR DELETE ON pharmacy_prescriptions FOR EACH ROW EXECUTE FUNCTION fixture_immutable();
\ir ../../prisma/migrations/20261102010000_pharmacy_retention_enforcement/migration.sql
CREATE FUNCTION fixture_assert(ok boolean, message text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'assertion failed: %', message; END IF; END $$;
CREATE FUNCTION fixture_refuses(statement text, expected_message text, expected_state text DEFAULT '55000') RETURNS void LANGUAGE plpgsql AS $$
DECLARE did_raise boolean := false;
BEGIN
  BEGIN EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    did_raise := true;
    IF SQLSTATE <> expected_state OR SQLERRM NOT LIKE '%' || expected_message || '%' THEN RAISE; END IF;
  END;
  IF NOT did_raise THEN RAISE EXCEPTION 'statement unexpectedly accepted: %', statement; END IF;
END $$;
INSERT INTO organizations VALUES ('tenant','PHARMACY'), ('other','PHARMACY'), ('agency','AGENCY'), ('empty','PHARMACY');
INSERT INTO pharmacy_branches VALUES ('branch','tenant','2010-01-01',true), ('other-branch','other','2010-01-01',true);
INSERT INTO pharmacy_jurisdiction_rule_sets VALUES
 ('rule-old','PK-TEST',1,'2010-01-01','2025-01-01',false,'{"provisional":false,"values":{"PRESCRIPTION":30,"CONTROLLED_REGISTER":40,"FISCAL":50,"AUDIT":60}}','{"provisional":false,"values":{"default":20,"controlled":35}}'),
 ('rule-new','PK-TEST',2,'2025-01-01',NULL,false,'{"provisional":false,"values":{"PRESCRIPTION":70,"CONTROLLED_REGISTER":80,"FISCAL":90,"AUDIT":100}}','{"provisional":false,"values":{"default":75}}');
INSERT INTO pharmacy_branch_regulatory_profiles VALUES ('profile','tenant','branch',1,'2010-01-01',NULL,false,'rule-old');
INSERT INTO pharmacy_prescriptions VALUES ('rx','tenant','2024-01-01');
INSERT INTO pharmacy_controlled_register_entries VALUES ('controlled','tenant','branch','2024-01-01');
INSERT INTO pharmacy_sales VALUES ('sale','tenant','branch','2024-01-01','COMPLETED'), ('future-sale','tenant','branch',(clock_timestamp() AT TIME ZONE 'UTC'),'COMPLETED'), ('open-sale','tenant','branch',(clock_timestamp() AT TIME ZONE 'UTC'),'OPEN');
INSERT INTO audit_logs VALUES ('audit','tenant','2024-01-01',NULL), ('new-audit','tenant','2025-01-01',NULL), ('agency-audit','agency','2024-01-01',NULL), ('missing-scope','empty','2024-01-01',NULL);
UPDATE organizations SET vertical='RESTAURANT' WHERE id='agency';
UPDATE audit_logs SET "createdAt"='2024-02-01' WHERE id='agency-audit';
SELECT fixture_assert((SELECT vertical = 'RESTAURANT' FROM organizations WHERE id='agency'), 'unrelated organization scope updates preserved');
INSERT INTO organizations VALUES ('agency-delete','AGENCY');
INSERT INTO audit_logs VALUES ('agency-delete-audit','agency-delete','2024-01-01',NULL);
DELETE FROM organizations WHERE id='agency-delete';
SELECT fixture_assert(NOT EXISTS (SELECT 1 FROM organizations WHERE id='agency-delete'), 'unrelated organization deletion preserved');
SELECT fixture_assert(pharmacy_record_retention_deadline('tenant','PRESCRIPTION','rx') = '2024-02-05', 'Rx max classification and class days');
SELECT fixture_assert(pharmacy_record_retention_deadline('tenant','CONTROLLED_REGISTER','controlled','branch') = '2024-02-10', 'controlled class');
SELECT fixture_assert(pharmacy_record_retention_deadline('tenant','FISCAL','sale','branch') = '2024-02-20', 'fiscal class');
SELECT fixture_assert(pharmacy_record_retention_deadline('tenant','AUDIT','audit') = '2024-03-01', 'leap-year calendar boundary');
SELECT fixture_assert(pharmacy_record_retention_deadline('tenant','AUDIT','new-audit') = '2025-04-11', 'effectiveTo exclusive / effectiveFrom inclusive');
INSERT INTO pharmacy_retention_classes VALUES ('shorter','tenant','AUDIT',5,'2020-01-01');
SELECT fixture_assert(pharmacy_record_retention_deadline('tenant','AUDIT','audit') = '2024-03-01', 'tenant cannot shorten jurisdiction');
INSERT INTO pharmacy_retention_classes VALUES ('longer','tenant','AUDIT',65,'2023-01-01');
SELECT fixture_assert(pharmacy_record_retention_deadline('tenant','AUDIT','audit') = '2024-03-06', 'tenant may lengthen');
SELECT fixture_refuses($q$SELECT pharmacy_record_retention_deadline('other','FISCAL','sale')$q$, 'missing or outside tenant');
SELECT fixture_refuses($q$SELECT pharmacy_record_retention_deadline('tenant','FISCAL','sale','other-branch')$q$, 'outside branch');
SELECT fixture_refuses($q$SELECT pharmacy_record_retention_deadline('tenant','PRESCRIPTION','rx','branch')$q$, 'outside branch');
SELECT fixture_refuses($q$SELECT pharmacy_record_retention_deadline('empty','AUDIT','missing-scope')$q$, 'historical pharmacy branch');
INSERT INTO pharmacy_legal_hold_events VALUES ('h1','tenant','AUDIT','audit','hold','PLACED','2025-01-01');
SELECT fixture_refuses($q$DELETE FROM audit_logs WHERE id='audit'$q$, 'protected by legal hold');
SELECT fixture_assert((SELECT "blockedReason" LIKE '%legal hold%' AND "retentionUntil" IS NULL FROM pharmacy_record_retention_status('tenant','AUDIT','audit')), 'status reports expected refusal');
INSERT INTO pharmacy_legal_hold_events VALUES ('h2','tenant','AUDIT','audit','hold','RELEASED','2025-01-02');
SELECT fixture_assert(pharmacy_record_retention_deadline('tenant','AUDIT','audit') = '2024-03-06', 'release latest hold');
INSERT INTO pharmacy_legal_hold_events VALUES ('h3','tenant','AUDIT','audit','second-hold','PLACED','2025-01-03');
SELECT fixture_refuses($q$DELETE FROM audit_logs WHERE id='audit'$q$, 'protected by legal hold');
INSERT INTO pharmacy_legal_hold_events VALUES ('h4','tenant','AUDIT','audit','second-hold','RELEASED','2025-01-04');
SELECT fixture_refuses($q$DELETE FROM pharmacy_sales WHERE id='future-sale'$q$, 'retained until');
SELECT fixture_refuses($q$UPDATE pharmacy_sales SET "createdAt"='1900-01-01' WHERE id='future-sale'$q$, 'creation time are immutable');
SELECT fixture_refuses($q$UPDATE pharmacy_sales SET status='OPEN' WHERE id='future-sale'$q$, 'cannot return to an open cart');
SELECT fixture_refuses($q$UPDATE audit_logs SET "organizationId"='agency' WHERE id='audit'$q$, 'scope and creation time');
UPDATE audit_logs SET "actorId"=NULL WHERE id='audit';
UPDATE pharmacy_branches SET active=false WHERE id='branch';
SELECT fixture_refuses($q$DELETE FROM pharmacy_branches WHERE id='branch'$q$, 'scope cannot change');
SELECT fixture_refuses($q$UPDATE organizations SET vertical='AGENCY' WHERE id='tenant'$q$, 'scope cannot change');
SELECT fixture_refuses($q$TRUNCATE pharmacy_sales$q$, 'cannot be truncated');
SELECT fixture_refuses($q$DELETE FROM pharmacy_prescriptions WHERE id='rx'$q$, 'legacy append-only', '23514');
INSERT INTO pharmacy_sale_lines (id,"organizationId","branchId","saleId","createdAt") VALUES ('line','tenant','branch','future-sale','2026-01-01'),('open-line','tenant','branch','open-sale','2026-01-01');
SELECT fixture_refuses($q$DELETE FROM pharmacy_sale_lines WHERE id='line'$q$, 'retained until');
SELECT fixture_refuses($q$UPDATE pharmacy_sale_lines SET "saleId"='open-sale' WHERE id='line'$q$, 'aggregate linkage is immutable');
INSERT INTO pharmacy_legal_hold_events VALUES ('open-held','tenant','FISCAL','open-sale','open-hold','PLACED','2025-01-01');
SELECT fixture_refuses($q$DELETE FROM pharmacy_sale_lines WHERE id='open-line'$q$, 'protected by legal hold');
INSERT INTO pharmacy_legal_hold_events VALUES ('open-released','tenant','FISCAL','open-sale','open-hold','RELEASED','2025-01-02');
DELETE FROM pharmacy_sale_lines WHERE id='open-line';
SELECT fixture_assert(NOT EXISTS (SELECT 1 FROM pharmacy_sale_lines WHERE id='open-line'), 'open cart remains editable');
-- Missing and malformed rules must not be masked by tenant policy.
INSERT INTO pharmacy_branches VALUES ('missing-profile','tenant','2010-01-01',true);
SELECT fixture_refuses($q$SELECT pharmacy_record_retention_deadline('tenant','AUDIT','audit')$q$, 'confirmed effective branch profile');
INSERT INTO pharmacy_branch_regulatory_profiles VALUES ('missing-profile-rule','tenant','missing-profile',1,'2010-01-01',NULL,false,'rule-old');
INSERT INTO pharmacy_jurisdiction_rule_sets VALUES ('invalid','INVALID',1,'2010-01-01',NULL,false,'{"provisional":true,"values":{"AUDIT":1}}','{}');
INSERT INTO pharmacy_branch_regulatory_profiles VALUES ('invalid-profile','tenant','missing-profile',2,'2023-01-01',NULL,false,'invalid');
SELECT fixture_refuses($q$SELECT pharmacy_record_retention_deadline('tenant','AUDIT','audit')$q$, 'confirmed jurisdiction');
UPDATE pharmacy_jurisdiction_rule_sets SET "recordRetentionByClass"='{"provisional":false,"values":{"AUDIT":0}}' WHERE id='invalid';
SELECT fixture_refuses($q$SELECT pharmacy_record_retention_deadline('tenant','AUDIT','audit')$q$, 'positive integer');
UPDATE pharmacy_jurisdiction_rule_sets SET "recordRetentionByClass"='{"provisional":false,"values":{"AUDIT":1.5}}' WHERE id='invalid';
SELECT fixture_refuses($q$SELECT pharmacy_record_retention_deadline('tenant','AUDIT','audit')$q$, 'positive integer');
UPDATE pharmacy_jurisdiction_rule_sets SET "recordRetentionByClass"='{"provisional":false,"values":{"AUDIT":"20"}}' WHERE id='invalid';
SELECT fixture_refuses($q$SELECT pharmacy_record_retention_deadline('tenant','AUDIT','audit')$q$, 'confirmed jurisdiction');
UPDATE pharmacy_jurisdiction_rule_sets SET "recordRetentionByClass"='{"provisional":false,"values":{"AUDIT":80}}' WHERE id='invalid';
SELECT fixture_assert(pharmacy_record_retention_deadline('tenant','AUDIT','audit') = '2024-03-21', 'all historical branches max');
-- The fixture permits rule mutations solely to cover malformed input states.
DELETE FROM audit_logs WHERE id='audit';
DELETE FROM audit_logs WHERE id='agency-audit';
SELECT fixture_assert(NOT EXISTS (SELECT 1 FROM audit_logs WHERE id IN ('audit','agency-audit')), 'expired and non-pharmacy audit deletion');
SELECT fixture_refuses($q$DELETE FROM audit_logs WHERE id='missing-scope'$q$, 'historical pharmacy branch');
-- Exact deadline has elapsed at statement execution, and is permitted.
INSERT INTO audit_logs VALUES ('boundary','tenant',(clock_timestamp() AT TIME ZONE 'UTC') - interval '100 days',NULL);
DELETE FROM audit_logs WHERE id='boundary';
SELECT fixture_assert(NOT EXISTS (SELECT 1 FROM audit_logs WHERE id='boundary'), 'deadline boundary permits deletion');
\echo 'DEV-96 SQL fixture passed'
-- Tenant-scoped runtime role: source/hold/policy reads keep RLS; only the mutex
-- updater is SECURITY DEFINER and exposes no tenant data.
CREATE ROLE dev96_fixture_runtime NOLOGIN;
GRANT USAGE ON SCHEMA public TO dev96_fixture_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dev96_fixture_runtime;
REVOKE ALL ON pharmacy_retention_mutex FROM dev96_fixture_runtime;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_branches','pharmacy_branch_regulatory_profiles','pharmacy_retention_classes',
    'pharmacy_legal_hold_events','pharmacy_prescriptions','pharmacy_controlled_register_entries','pharmacy_sales','audit_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY fixture_tenant ON %I USING ("organizationId" = current_setting(''app.current_organization_id'',true)) WITH CHECK ("organizationId" = current_setting(''app.current_organization_id'',true))', t);
  END LOOP;
END $$;
SET ROLE dev96_fixture_runtime;
SELECT set_config('app.current_organization_id','tenant',false);
SELECT fixture_assert(pharmacy_record_retention_deadline('tenant','FISCAL','sale','branch') = '2024-02-20', 'tenant RLS resolver and private mutex');
SELECT fixture_refuses($q$SELECT pharmacy_record_retention_deadline('other','FISCAL','sale')$q$, 'missing or outside tenant');
SELECT fixture_refuses($q$UPDATE pharmacy_retention_mutex SET version=false$q$, 'permission denied', '42501');
RESET ROLE;
\echo 'DEV-96 SQL RLS fixture passed'
