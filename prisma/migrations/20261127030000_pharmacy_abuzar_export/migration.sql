BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS pharmacy_abuzar_parties (
  "organizationId" text NOT NULL REFERENCES organizations(id),
  "sourceId" text NOT NULL,
  "customerId" text,
  "supplierId" text,
  "rowHash" text NOT NULL CHECK ("rowHash" ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY ("organizationId", "sourceId"),
  UNIQUE ("organizationId", "customerId"),
  UNIQUE ("organizationId", "supplierId"),
  CHECK (num_nonnulls("customerId", "supplierId") = 1),
  FOREIGN KEY ("organizationId", "customerId") REFERENCES pharmacy_customers("organizationId", id),
  FOREIGN KEY ("organizationId", "supplierId") REFERENCES pharmacy_suppliers("organizationId", id)
);

CREATE TABLE IF NOT EXISTS pharmacy_abuzar_history (
  "organizationId" text NOT NULL,
  "branchId" text NOT NULL,
  "sourceBranch" text NOT NULL,
  "sourceId" text NOT NULL,
  label text GENERATED ALWAYS AS ('Imported from Abuzar'::text) STORED,
  kind text NOT NULL CHECK (kind IN ('sale','purchase','sale-return','purchase-return','purchase-order','adjustment','movement','accounting')),
  "documentNo" text NOT NULL,
  "documentDate" date NOT NULL,
  "productCode" text,
  quantity text,
  "unitPrice" text,
  amount text,
  "rowHash" text NOT NULL CHECK ("rowHash" ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY ("organizationId", "sourceBranch", "sourceId"),
  FOREIGN KEY ("organizationId", "branchId") REFERENCES pharmacy_branches("organizationId", id)
);
CREATE INDEX IF NOT EXISTS pharmacy_abuzar_history_document ON pharmacy_abuzar_history
  ("organizationId", "branchId", "documentNo", "sourceId");

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_abuzar_parties', 'pharmacy_abuzar_history'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT FROM pg_policy WHERE polrelid = to_regclass(t) AND polname = 'tenant_read') THEN
      EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT USING ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))', t);
    END IF;
    IF NOT EXISTS (SELECT FROM pg_policy WHERE polrelid = to_regclass(t) AND polname = 'tenant_append') THEN
      EXECUTE format('CREATE POLICY tenant_append ON %I FOR INSERT WITH CHECK ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))', t);
    END IF;
  END LOOP;
END $$;
COMMIT;
