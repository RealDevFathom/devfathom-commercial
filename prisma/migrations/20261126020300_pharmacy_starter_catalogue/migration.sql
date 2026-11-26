BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS pharmacy_starter_imports (
  "organizationId" text PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
  "catalogueHash" text,
  total integer,
  processed integer NOT NULL DEFAULT 0 CHECK (processed >= 0),
  added integer NOT NULL DEFAULT 0 CHECK (added >= 0),
  matched integer NOT NULL DEFAULT 0 CHECK (matched >= 0),
  "editsKept" integer NOT NULL DEFAULT 0 CHECK ("editsKept" >= 0),
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "progressedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" timestamp(3),
  CHECK (processed = added + matched)
);
CREATE TABLE IF NOT EXISTS pharmacy_starter_identities (
  "organizationId" text NOT NULL REFERENCES pharmacy_starter_imports("organizationId"),
  "sourceId" text NOT NULL,
  "medicineId" text NOT NULL,
  "narcoticsReview" boolean NOT NULL,
  PRIMARY KEY ("organizationId","sourceId"),
  UNIQUE ("organizationId","medicineId"),
  FOREIGN KEY ("organizationId","medicineId") REFERENCES pharmacy_medicines("organizationId",id)
);
CREATE TABLE IF NOT EXISTS pharmacy_starter_conflicts (
  "organizationId" text NOT NULL,
  "sourceId" text NOT NULL,
  field text NOT NULL CHECK (field IN ('packSize','controlled','active')),
  "existingValue" text NOT NULL,
  "starterValue" text NOT NULL CHECK ("starterValue" <> "existingValue"),
  PRIMARY KEY ("organizationId","sourceId",field),
  FOREIGN KEY ("organizationId","sourceId") REFERENCES pharmacy_starter_identities("organizationId","sourceId")
);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_starter_imports','pharmacy_starter_identities','pharmacy_starter_conflicts']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_scope ON %I', t);
    EXECUTE format('CREATE POLICY tenant_scope ON %I USING ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))',t);
  END LOOP;
END $$;
-- Dispatch can discover work and provision a queue entry. The product writer runs as its tenant.
DROP POLICY IF EXISTS dispatch_read ON pharmacy_starter_imports;
CREATE POLICY dispatch_read ON pharmacy_starter_imports FOR SELECT USING (current_setting('app.is_platform_admin',true) = 'true');
DROP POLICY IF EXISTS provision_queue ON pharmacy_starter_imports;
CREATE POLICY provision_queue ON pharmacy_starter_imports FOR INSERT WITH CHECK (current_setting('app.is_platform_admin',true) = 'true');
COMMIT;
