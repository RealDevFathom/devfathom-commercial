-- PH-MIG import 2/5: isolated historical sales and audited loyalty policy.
CREATE TABLE "pharmacy_imported_sales" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "importBatchId" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "customerId" TEXT,
  "invoiceNumber" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "totalMinor" BIGINT NOT NULL,
  "costMinor" BIGINT,
  "payload" JSONB NOT NULL,
  "imported" BOOLEAN NOT NULL DEFAULT true,
  "loyaltyPointsAwarded" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_imported_sales_imported_check" CHECK (imported = true),
  CONSTRAINT "pharmacy_imported_sales_money_check" CHECK ("totalMinor" >= 0 AND ("costMinor" IS NULL OR "costMinor" >= 0)),
  CONSTRAINT "pharmacy_imported_sales_loyalty_check" CHECK ("loyaltyPointsAwarded" >= 0),
  CONSTRAINT "pharmacy_imported_sales_batch_fkey" FOREIGN KEY ("organizationId", "importBatchId")
    REFERENCES "pharmacy_migration_batches" ("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_imported_sales_branch_fkey" FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "pharmacy_branches" ("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_imported_sales_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "pharmacy_imported_sales_source_key" UNIQUE ("organizationId", "importBatchId", "sourceKey")
);
CREATE INDEX "pharmacy_imported_sales_org_branch_occurred_idx" ON "pharmacy_imported_sales" ("organizationId", "branchId", "occurredAt");
CREATE INDEX "pharmacy_imported_sales_org_customer_occurred_idx" ON "pharmacy_imported_sales" ("organizationId", "customerId", "occurredAt");

CREATE TABLE "pharmacy_import_loyalty_decisions" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "enabled" BOOLEAN NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_import_loyalty_decisions_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "pharmacy_import_loyalty_decisions_reason_check" CHECK (length(btrim(reason)) > 0),
  CONSTRAINT "pharmacy_import_loyalty_decisions_actor_fkey" FOREIGN KEY ("organizationId", "actorUserId")
    REFERENCES "users" ("organizationId", "id") ON DELETE RESTRICT
);
CREATE INDEX "pharmacy_import_loyalty_decisions_org_created_idx" ON "pharmacy_import_loyalty_decisions" ("organizationId", "createdAt");

-- Tenant tables use the same forced-RLS contract as the migration staging tables.
DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['pharmacy_imported_sales', 'pharmacy_import_loyalty_decisions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("organizationId" = current_setting(''app.current_organization_id'', true)) WITH CHECK ("organizationId" = current_setting(''app.current_organization_id'', true))',
      table_name || '_tenant_isolation', table_name
    );
  END LOOP;
END $rls$;

-- data-import is exact-grant-only: explicitly preserve only the pharmacy Owner
-- and Manager system templates. Central can() still applies DENY before ALLOW.
SELECT set_config('app.is_platform_admin', 'true', true);
INSERT INTO organization_role_permissions
  (id, "organizationId", "organizationRoleId", capability, effect, "createdAt")
SELECT 'ph_import_' || md5(r.id), r."organizationId", r.id,
       'pharmacy:data-import', 'ALLOW'::"PermissionEffect", now()
FROM organization_roles r JOIN organizations o ON o.id = r."organizationId"
WHERE o.vertical = 'PHARMACY' AND r.key IN ('owner', 'manager') AND r."isSystem" = true
ON CONFLICT ("organizationRoleId", capability) DO NOTHING;
