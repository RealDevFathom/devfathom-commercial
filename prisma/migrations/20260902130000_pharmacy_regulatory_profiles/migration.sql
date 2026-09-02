CREATE TABLE "pharmacy_jurisdiction_rule_sets" (
  "id" TEXT PRIMARY KEY,
  "code" TEXT NOT NULL,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo" TIMESTAMP(3),
  "licenceCategories" JSONB NOT NULL,
  "permittedSchedules" JSONB NOT NULL,
  "prescriptionOnlyClasses" JSONB NOT NULL,
  "prescriptionRetentionDays" JSONB NOT NULL,
  "controlledRegisterFlags" JSONB NOT NULL,
  "pharmacistCoverageRule" JSONB NOT NULL,
  "recordRetentionByClass" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_jurisdiction_rule_sets_dates_ck"
    CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom"),
  UNIQUE ("code", "version")
);
CREATE INDEX "pharmacy_jurisdiction_rule_sets_effective_idx"
  ON "pharmacy_jurisdiction_rule_sets"("code", "effectiveFrom", "effectiveTo");
ALTER TABLE "pharmacy_jurisdiction_rule_sets" ADD CONSTRAINT "pharmacy_jurisdiction_rule_sets_no_overlap"
  EXCLUDE USING gist ("code" WITH =, tsrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamp), '[)') WITH &&);

CREATE TABLE "pharmacy_branch_regulatory_profiles" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo" TIMESTAMP(3),
  "provinceCode" TEXT NOT NULL,
  "jurisdictionRuleSetId" TEXT NOT NULL REFERENCES "pharmacy_jurisdiction_rule_sets"("id") ON DELETE RESTRICT,
  "premises" JSONB NOT NULL,
  "licenceCategory" TEXT NOT NULL CHECK (length(btrim("licenceCategory")) > 0),
  "licenceNumber" TEXT NOT NULL CHECK (length(btrim("licenceNumber")) > 0),
  "licenceValidFrom" TIMESTAMP(3) NOT NULL,
  "licenceValidTo" TIMESTAMP(3) NOT NULL,
  "licenceEvidenceFileRef" TEXT NOT NULL CHECK (length(btrim("licenceEvidenceFileRef")) > 0),
  "permittedSchedules" TEXT[] NOT NULL,
  "qualifiedPersonRegistration" TEXT NOT NULL CHECK (length(btrim("qualifiedPersonRegistration")) > 0),
  "qualifiedPersonValidFrom" TIMESTAMP(3) NOT NULL,
  "qualifiedPersonValidTo" TIMESTAMP(3) NOT NULL,
  "qualifiedPersonCoverageRosterRef" TEXT NOT NULL CHECK (length(btrim("qualifiedPersonCoverageRosterRef")) > 0),
  "ntn" TEXT,
  "strn" TEXT,
  "fiscalStatus" TEXT NOT NULL CHECK (length(btrim("fiscalStatus")) > 0),
  "retentionPolicy" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_branch_regulatory_profiles_dates_ck" CHECK (
    ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom") AND
    "licenceValidTo" > "licenceValidFrom" AND
    "qualifiedPersonValidTo" > "qualifiedPersonValidFrom"
  ),
  UNIQUE ("organizationId", "branchId", "version")
);
CREATE INDEX "pharmacy_branch_regulatory_profiles_effective_idx"
  ON "pharmacy_branch_regulatory_profiles"("organizationId", "branchId", "effectiveFrom", "effectiveTo");
CREATE INDEX "pharmacy_branch_regulatory_profiles_rules_idx"
  ON "pharmacy_branch_regulatory_profiles"("jurisdictionRuleSetId");
ALTER TABLE "pharmacy_branch_regulatory_profiles" ADD CONSTRAINT "pharmacy_branch_regulatory_profiles_no_overlap"
  EXCLUDE USING gist (
    "organizationId" WITH =,
    "branchId" WITH =,
    tsrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamp), '[)') WITH &&
  );

CREATE FUNCTION pharmacy_reject_regulatory_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."effectiveTo" IS NULL
     AND NEW."effectiveTo" IS NOT NULL
     AND NEW."effectiveTo" > OLD."effectiveFrom"
     AND (to_jsonb(NEW) - 'effectiveTo') = (to_jsonb(OLD) - 'effectiveTo') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only; create a new effective-dated version', TG_TABLE_NAME
    USING ERRCODE = '23514';
END $$;
CREATE TRIGGER pharmacy_jurisdiction_rule_sets_immutable
  BEFORE UPDATE OR DELETE ON "pharmacy_jurisdiction_rule_sets"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_regulatory_rewrite();
CREATE TRIGGER pharmacy_branch_regulatory_profiles_immutable
  BEFORE UPDATE OR DELETE ON "pharmacy_branch_regulatory_profiles"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_regulatory_rewrite();

ALTER TABLE "pharmacy_branch_regulatory_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_branch_regulatory_profiles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "pharmacy_branch_regulatory_profiles"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

-- Seed the provisional PK-PB rule set BEFORE row-level security is forced:
-- the migration role is not a superuser on the gate cluster or on Azure, so an
-- INSERT after FORCE RLS would be rejected by the platform-admin-only policy.
INSERT INTO "pharmacy_jurisdiction_rule_sets" (
  "id", "code", "version", "effectiveFrom", "licenceCategories",
  "permittedSchedules", "prescriptionOnlyClasses", "prescriptionRetentionDays",
  "controlledRegisterFlags", "pharmacistCoverageRule", "recordRetentionByClass"
) VALUES (
  'pk_pb_provisional_v1', 'PK-PB', 1, '2026-09-02T00:00:00.000Z',
  '{"values":[],"provisional":true,"toConfirm":"PHARM-P0-COUNSEL-001 C-01..C-08"}',
  '{"values":[],"provisional":true,"toConfirm":"PHARM-P0-COUNSEL-001 C-17..C-25"}',
  '{"values":[],"provisional":true,"toConfirm":"PHARM-P0-COUNSEL-001 C-17..C-25"}',
  '{"values":{},"provisional":true,"toConfirm":"PHARM-P0-COUNSEL-001 C-26..C-31"}',
  '{"values":{},"provisional":true,"toConfirm":"PHARM-P0-COUNSEL-001 C-32..C-39"}',
  '{"values":{},"provisional":true,"toConfirm":"PHARM-P0-COUNSEL-001 C-09..C-16"}',
  '{"values":{},"provisional":true,"toConfirm":"PHARM-P0-COUNSEL-001 C-53..C-58"}'
);

ALTER TABLE "pharmacy_jurisdiction_rule_sets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_jurisdiction_rule_sets" FORCE ROW LEVEL SECURITY;
CREATE POLICY "jurisdiction_rules_read" ON "pharmacy_jurisdiction_rule_sets"
  FOR SELECT USING (true);
CREATE POLICY "jurisdiction_rules_platform_insert" ON "pharmacy_jurisdiction_rule_sets"
  FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
CREATE POLICY "jurisdiction_rules_platform_update" ON "pharmacy_jurisdiction_rule_sets"
  FOR UPDATE
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

