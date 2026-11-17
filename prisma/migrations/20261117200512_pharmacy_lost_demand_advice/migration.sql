-- DEV-80: lost-demand procurement advice. Per-branch trigger settings (research
-- figures are defaults only) and an append-only log of what a human did with each
-- advice card. Drafts are created through the existing purchase-order and transfer
-- tables; nothing here approves or sends a document.
BEGIN;

CREATE TABLE IF NOT EXISTS "pharmacy_lost_demand_trigger_settings" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "requestCountThreshold" INTEGER NOT NULL DEFAULT 3,
  "requestWindowDays" INTEGER NOT NULL DEFAULT 7,
  "estimatedLossThresholdMinor" INTEGER NOT NULL DEFAULT 1000000,
  "lossWindowDays" INTEGER NOT NULL DEFAULT 30,
  "walkOutRateThresholdBps" INTEGER NOT NULL DEFAULT 1000,
  "forecastWindowDays" INTEGER NOT NULL DEFAULT 30,
  "safetyStockDays" INTEGER NOT NULL DEFAULT 7,
  "defaultLeadTimeDays" INTEGER NOT NULL DEFAULT 3,
  "updatedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_lost_demand_trigger_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_lost_demand_trigger_settings_values_check" CHECK (
    "requestCountThreshold" BETWEEN 1 AND 10000
    AND "requestWindowDays" BETWEEN 1 AND 90
    AND "estimatedLossThresholdMinor" >= 1
    AND "lossWindowDays" BETWEEN 1 AND 365
    AND "walkOutRateThresholdBps" BETWEEN 1 AND 10000
    AND "forecastWindowDays" BETWEEN 7 AND 365
    AND "safetyStockDays" BETWEEN 0 AND 180
    AND "defaultLeadTimeDays" BETWEEN 0 AND 180
  ),
  CONSTRAINT "pharmacy_lost_demand_trigger_settings_branch_fkey" FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_lost_demand_trigger_settings_org_branch_key"
  ON "pharmacy_lost_demand_trigger_settings"("organizationId", "branchId");

CREATE TABLE IF NOT EXISTS "pharmacy_lost_demand_advice_decisions" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "demandKey" TEXT NOT NULL,
  "decision" TEXT NOT NULL,
  "purchaseOrderId" TEXT,
  "transferId" TEXT,
  "reason" TEXT,
  "actorUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_lost_demand_advice_decisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_lost_demand_advice_decisions_shape_check" CHECK (
    length("demandKey") BETWEEN 1 AND 300
    AND (
      ("decision" = 'DRAFT_PURCHASE_ORDER' AND "purchaseOrderId" IS NOT NULL AND "transferId" IS NULL)
      OR ("decision" = 'TRANSFER_REQUEST' AND "transferId" IS NOT NULL AND "purchaseOrderId" IS NULL)
      OR ("decision" = 'IGNORED' AND "purchaseOrderId" IS NULL AND "transferId" IS NULL)
    )
  ),
  CONSTRAINT "pharmacy_lost_demand_advice_decisions_branch_fkey" FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "pharmacy_lost_demand_advice_decisions_key_idx"
  ON "pharmacy_lost_demand_advice_decisions"("organizationId", "branchId", "demandKey", "createdAt");

-- Append-only, except when the row's own tenant is destroyed: the retention
-- worker's purge (transaction-local "app.purging_organization_id" naming this
-- tenant, inside the platform control plane's "app.is_platform_admin" = 'true'
-- transaction, as 20261021104500_purge_guards_require_platform_admin requires of
-- every purge guard) or the organization row already being gone. A tenant
-- transaction that names its own organization deletes nothing. UPDATE is always
-- refused.
CREATE OR REPLACE FUNCTION pharmacy_lost_demand_decisions_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId"
       AND current_setting('app.is_platform_admin', true) = 'true' THEN
      RETURN OLD;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "organizations" WHERE "id" = OLD."organizationId") THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;

DROP TRIGGER IF EXISTS pharmacy_lost_demand_decisions_append_only ON "pharmacy_lost_demand_advice_decisions";
CREATE TRIGGER pharmacy_lost_demand_decisions_append_only
  BEFORE UPDATE OR DELETE ON "pharmacy_lost_demand_advice_decisions"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_lost_demand_decisions_append_only();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_lost_demand_trigger_settings','pharmacy_lost_demand_advice_decisions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.is_platform_admin'',true)=''true'' OR "organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),'''')) WITH CHECK (current_setting(''app.is_platform_admin'',true)=''true'' OR "organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),''''))', t);
  END LOOP;
END $$;

COMMIT;
