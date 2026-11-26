BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS pharmacy_abuzar_product_fields (
  "organizationId" text NOT NULL,
  "sourceId" text NOT NULL,
  "medicineId" text NOT NULL,
  shelf text,
  "legacyCode" text,
  "packCostMinor" integer CHECK ("packCostMinor" >= 0),
  "packMrpMinor" integer CHECK ("packMrpMinor" > 0),
  "unitMrpMinor" integer CHECK ("unitMrpMinor" >= 0),
  PRIMARY KEY ("organizationId","sourceId"),
  UNIQUE ("organizationId","medicineId"),
  FOREIGN KEY ("organizationId","medicineId") REFERENCES pharmacy_medicines("organizationId",id)
);
ALTER TABLE pharmacy_abuzar_product_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_abuzar_product_fields FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policy WHERE polrelid='pharmacy_abuzar_product_fields'::regclass AND polname='tenant_read') THEN
    CREATE POLICY tenant_read ON pharmacy_abuzar_product_fields FOR SELECT USING
      ("organizationId"=nullif(current_setting('app.current_organization_id',true),''));
  END IF;
  IF NOT EXISTS (SELECT FROM pg_policy WHERE polrelid='pharmacy_abuzar_product_fields'::regclass AND polname='tenant_append') THEN
    CREATE POLICY tenant_append ON pharmacy_abuzar_product_fields FOR INSERT WITH CHECK
      ("organizationId"=nullif(current_setting('app.current_organization_id',true),''));
  END IF;
END $$;
COMMIT;
