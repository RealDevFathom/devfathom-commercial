-- M8-L1 — Organization-scoped restaurant customers, consent history, loyalty
-- ledger, insight read models and restricted imported labour-cost facts.
--
-- Rollback is intentionally manual because Prisma deploy has no down-migration
-- runner. Before any dependent M8 lane writes data: drop
-- prevent_effective_loyalty_program_version_mutation(), drop the 12 M8 tables
-- in reverse dependency order, drop RestaurantOrder.customerId and
-- RestaurantBill.discountTotal, then drop the three M8 enums. Every change is
-- additive, so that recovery loses only M8 data and restores the M7 schema.

-- CreateEnum
CREATE TYPE "CustomerIdentifierKind" AS ENUM ('EMAIL', 'PHONE');

-- CreateEnum
CREATE TYPE "CustomerConsentChannel" AS ENUM ('EMAIL', 'SMS', 'PHONE', 'WHATSAPP', 'PUSH');

-- CreateEnum
CREATE TYPE "LoyaltyPointsEntryKind" AS ENUM ('EARN', 'REDEEM', 'REVERSAL', 'EXPIRY', 'ADJUSTMENT');

-- AlterTable
ALTER TABLE "restaurant_orders" ADD COLUMN "customerId" TEXT;

-- AlterTable
ALTER TABLE "restaurant_bills" ADD COLUMN "discountTotal" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "restaurant_customers" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "displayName" TEXT,
    "givenName" TEXT,
    "familyName" TEXT,
    "birthDate" DATE,
    "notes" TEXT,
    "anonymizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_customer_identifiers" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "customerId" TEXT NOT NULL,
    "kind" "CustomerIdentifierKind" NOT NULL,
    "normalizedValue" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_customer_identifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_customer_interactions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "customerId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "orderId" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_customer_interactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_customer_tags" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "name" TEXT NOT NULL,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_customer_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_customer_tag_assignments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "customerId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_customer_tag_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_customer_consents" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "customerId" TEXT NOT NULL,
    "channel" "CustomerConsentChannel" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_customer_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_loyalty_program_versions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "versionNumber" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "earnRate" DECIMAL(18,6) NOT NULL,
    "redemptionValue" DECIMAL(18,6) NOT NULL,
    "expiryDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_loyalty_program_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_loyalty_accounts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "customerId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_loyalty_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_loyalty_points_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "accountId" TEXT NOT NULL,
    "programVersionId" TEXT NOT NULL,
    "kind" "LoyaltyPointsEntryKind" NOT NULL,
    "points" INTEGER NOT NULL,
    "billId" TEXT,
    "refundId" TEXT,
    "reversesEntryId" TEXT,
    "actorId" TEXT,
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_loyalty_points_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_insight_daily_rollups" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "sourceDailyCloseId" TEXT NOT NULL,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "coverCount" INTEGER NOT NULL DEFAULT 0,
    "grossSales" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "netSales" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "compTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "refundTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "voidTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "drawerVariance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "loyaltyLiability" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_insight_daily_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_insight_item_mix_rollups" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "productId" TEXT NOT NULL,
    "sourceDailyCloseId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "grossSales" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "netSales" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "compTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_insight_item_mix_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_labour_cost_facts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "labourHours" DECIMAL(12,2) NOT NULL,
    "labourCost" DECIMAL(12,2) NOT NULL,
    "source" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_labour_cost_facts_pkey" PRIMARY KEY ("id")
);

-- Prisma indexes and idempotency/dedupe keys
CREATE INDEX "restaurant_orders_customerId_idx" ON "restaurant_orders"("customerId");
CREATE INDEX "restaurant_customers_organizationId_idx" ON "restaurant_customers"("organizationId");
CREATE INDEX "restaurant_customers_anonymizedAt_idx" ON "restaurant_customers"("anonymizedAt");
CREATE INDEX "restaurant_customer_identifiers_organizationId_idx" ON "restaurant_customer_identifiers"("organizationId");
CREATE INDEX "restaurant_customer_identifiers_customerId_idx" ON "restaurant_customer_identifiers"("customerId");
CREATE UNIQUE INDEX "restaurant_customer_identifiers_org_kind_value_key" ON "restaurant_customer_identifiers"("organizationId", "kind", "normalizedValue");
CREATE INDEX "restaurant_customer_interactions_organizationId_idx" ON "restaurant_customer_interactions"("organizationId");
CREATE INDEX "restaurant_customer_interactions_customer_time_idx" ON "restaurant_customer_interactions"("customerId", "occurredAt");
CREATE INDEX "restaurant_customer_interactions_branch_time_idx" ON "restaurant_customer_interactions"("branchId", "occurredAt");
CREATE INDEX "restaurant_customer_interactions_orderId_idx" ON "restaurant_customer_interactions"("orderId");
CREATE UNIQUE INDEX "restaurant_customer_interactions_org_idempotency_key" ON "restaurant_customer_interactions"("organizationId", "idempotencyKey");
CREATE INDEX "restaurant_customer_tags_organizationId_idx" ON "restaurant_customer_tags"("organizationId");
CREATE UNIQUE INDEX "restaurant_customer_tags_org_name_key" ON "restaurant_customer_tags"("organizationId", lower(btrim("name")));
CREATE INDEX "restaurant_customer_tag_assignments_organizationId_idx" ON "restaurant_customer_tag_assignments"("organizationId");
CREATE INDEX "restaurant_customer_tag_assignments_tagId_idx" ON "restaurant_customer_tag_assignments"("tagId");
CREATE UNIQUE INDEX "restaurant_customer_tag_assignments_customer_tag_key" ON "restaurant_customer_tag_assignments"("customerId", "tagId");
CREATE INDEX "restaurant_customer_consents_organizationId_idx" ON "restaurant_customer_consents"("organizationId");
CREATE INDEX "restaurant_customer_consents_customer_channel_time_idx" ON "restaurant_customer_consents"("customerId", "channel", "occurredAt");
CREATE UNIQUE INDEX "restaurant_customer_consents_org_idempotency_key" ON "restaurant_customer_consents"("organizationId", "idempotencyKey");
CREATE INDEX "restaurant_loyalty_program_versions_organizationId_idx" ON "restaurant_loyalty_program_versions"("organizationId");
CREATE INDEX "restaurant_loyalty_program_versions_effectiveFrom_idx" ON "restaurant_loyalty_program_versions"("effectiveFrom");
CREATE UNIQUE INDEX "restaurant_loyalty_program_versions_org_version_key" ON "restaurant_loyalty_program_versions"("organizationId", "versionNumber");
CREATE UNIQUE INDEX "restaurant_loyalty_program_versions_org_effective_key" ON "restaurant_loyalty_program_versions"("organizationId", "effectiveFrom");
CREATE UNIQUE INDEX "restaurant_loyalty_accounts_customerId_key" ON "restaurant_loyalty_accounts"("customerId");
CREATE UNIQUE INDEX "restaurant_loyalty_accounts_org_customer_key" ON "restaurant_loyalty_accounts"("organizationId", "customerId");
CREATE INDEX "restaurant_loyalty_accounts_organizationId_idx" ON "restaurant_loyalty_accounts"("organizationId");
CREATE INDEX "restaurant_loyalty_accounts_active_idx" ON "restaurant_loyalty_accounts"("active");
CREATE INDEX "restaurant_loyalty_points_entries_organizationId_idx" ON "restaurant_loyalty_points_entries"("organizationId");
CREATE INDEX "restaurant_loyalty_points_entries_account_time_idx" ON "restaurant_loyalty_points_entries"("accountId", "occurredAt");
CREATE INDEX "restaurant_loyalty_points_entries_programVersionId_idx" ON "restaurant_loyalty_points_entries"("programVersionId");
CREATE INDEX "restaurant_loyalty_points_entries_billId_idx" ON "restaurant_loyalty_points_entries"("billId");
CREATE INDEX "restaurant_loyalty_points_entries_refundId_idx" ON "restaurant_loyalty_points_entries"("refundId");
CREATE INDEX "restaurant_loyalty_points_entries_reversesEntryId_idx" ON "restaurant_loyalty_points_entries"("reversesEntryId");
CREATE UNIQUE INDEX "restaurant_loyalty_points_entries_org_idempotency_key" ON "restaurant_loyalty_points_entries"("organizationId", "idempotencyKey");
CREATE UNIQUE INDEX "restaurant_loyalty_points_entries_bill_earn_key" ON "restaurant_loyalty_points_entries"("organizationId", "billId") WHERE "kind" = 'EARN' AND "billId" IS NOT NULL;
CREATE INDEX "restaurant_insight_daily_rollups_organizationId_idx" ON "restaurant_insight_daily_rollups"("organizationId");
CREATE INDEX "restaurant_insight_daily_rollups_sourceDailyCloseId_idx" ON "restaurant_insight_daily_rollups"("sourceDailyCloseId");
CREATE UNIQUE INDEX "restaurant_insight_daily_rollups_org_branch_date_key" ON "restaurant_insight_daily_rollups"("organizationId", "branchId", "businessDate");
CREATE INDEX "restaurant_insight_item_mix_rollups_organizationId_idx" ON "restaurant_insight_item_mix_rollups"("organizationId");
CREATE INDEX "restaurant_insight_item_mix_rollups_productId_idx" ON "restaurant_insight_item_mix_rollups"("productId");
CREATE INDEX "restaurant_insight_item_mix_rollups_sourceCloseId_idx" ON "restaurant_insight_item_mix_rollups"("sourceDailyCloseId");
CREATE UNIQUE INDEX "restaurant_insight_item_mix_rollups_org_branch_date_product_key" ON "restaurant_insight_item_mix_rollups"("organizationId", "branchId", "businessDate", "productId");
CREATE INDEX "restaurant_labour_cost_facts_organizationId_idx" ON "restaurant_labour_cost_facts"("organizationId");
CREATE INDEX "restaurant_labour_cost_facts_branch_date_idx" ON "restaurant_labour_cost_facts"("branchId", "businessDate");
CREATE UNIQUE INDEX "restaurant_labour_cost_facts_org_idempotency_key" ON "restaurant_labour_cost_facts"("organizationId", "idempotencyKey");

-- Single-column foreign keys generated from the Prisma relations.
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "restaurant_customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "restaurant_customer_identifiers" ADD CONSTRAINT "restaurant_customer_identifiers_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "restaurant_customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_customer_interactions" ADD CONSTRAINT "restaurant_customer_interactions_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "restaurant_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_customer_interactions" ADD CONSTRAINT "restaurant_customer_interactions_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_customer_interactions" ADD CONSTRAINT "restaurant_customer_interactions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "restaurant_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_customer_tag_assignments" ADD CONSTRAINT "restaurant_customer_tag_assignments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "restaurant_customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_customer_tag_assignments" ADD CONSTRAINT "restaurant_customer_tag_assignments_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "restaurant_customer_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_customer_consents" ADD CONSTRAINT "restaurant_customer_consents_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "restaurant_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_loyalty_accounts" ADD CONSTRAINT "restaurant_loyalty_accounts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "restaurant_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_loyalty_points_entries" ADD CONSTRAINT "restaurant_loyalty_points_entries_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "restaurant_loyalty_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_loyalty_points_entries" ADD CONSTRAINT "restaurant_loyalty_points_entries_programVersionId_fkey" FOREIGN KEY ("programVersionId") REFERENCES "restaurant_loyalty_program_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_loyalty_points_entries" ADD CONSTRAINT "restaurant_loyalty_points_entries_billId_fkey" FOREIGN KEY ("billId") REFERENCES "restaurant_bills"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "restaurant_loyalty_points_entries" ADD CONSTRAINT "restaurant_loyalty_points_entries_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "restaurant_refunds"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "restaurant_loyalty_points_entries" ADD CONSTRAINT "restaurant_loyalty_points_entries_reversesEntryId_fkey" FOREIGN KEY ("reversesEntryId") REFERENCES "restaurant_loyalty_points_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_insight_daily_rollups" ADD CONSTRAINT "restaurant_insight_daily_rollups_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_insight_daily_rollups" ADD CONSTRAINT "restaurant_insight_daily_rollups_sourceCloseId_fkey" FOREIGN KEY ("sourceDailyCloseId") REFERENCES "restaurant_daily_closes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_insight_item_mix_rollups" ADD CONSTRAINT "restaurant_insight_item_mix_rollups_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_insight_item_mix_rollups" ADD CONSTRAINT "restaurant_insight_item_mix_rollups_productId_fkey" FOREIGN KEY ("productId") REFERENCES "restaurant_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_insight_item_mix_rollups" ADD CONSTRAINT "restaurant_insight_item_mix_rollups_sourceCloseId_fkey" FOREIGN KEY ("sourceDailyCloseId") REFERENCES "restaurant_daily_closes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_labour_cost_facts" ADD CONSTRAINT "restaurant_labour_cost_facts_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Composite parent keys and deferred tenant-safe foreign keys.
ALTER TABLE "restaurant_customers" ADD CONSTRAINT "restaurant_customers_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_customer_tags" ADD CONSTRAINT "restaurant_customer_tags_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_loyalty_program_versions" ADD CONSTRAINT "restaurant_loyalty_program_versions_org_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_loyalty_accounts" ADD CONSTRAINT "restaurant_loyalty_accounts_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_loyalty_points_entries" ADD CONSTRAINT "restaurant_loyalty_points_entries_org_id_key" UNIQUE ("organizationId", "id");

ALTER TABLE "restaurant_orders" ADD CONSTRAINT "tenant_order_customerId_fk" FOREIGN KEY ("organizationId", "customerId") REFERENCES "restaurant_customers"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_customer_identifiers" ADD CONSTRAINT "tenant_customer_identifier_customerId_fk" FOREIGN KEY ("organizationId", "customerId") REFERENCES "restaurant_customers"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_customer_interactions" ADD CONSTRAINT "tenant_customer_interaction_customerId_fk" FOREIGN KEY ("organizationId", "customerId") REFERENCES "restaurant_customers"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_customer_interactions" ADD CONSTRAINT "tenant_customer_interaction_branchId_fk" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_customer_interactions" ADD CONSTRAINT "tenant_customer_interaction_orderId_fk" FOREIGN KEY ("organizationId", "orderId") REFERENCES "restaurant_orders"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_customer_tag_assignments" ADD CONSTRAINT "tenant_customer_tag_assignment_customerId_fk" FOREIGN KEY ("organizationId", "customerId") REFERENCES "restaurant_customers"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_customer_tag_assignments" ADD CONSTRAINT "tenant_customer_tag_assignment_tagId_fk" FOREIGN KEY ("organizationId", "tagId") REFERENCES "restaurant_customer_tags"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_customer_consents" ADD CONSTRAINT "tenant_customer_consent_customerId_fk" FOREIGN KEY ("organizationId", "customerId") REFERENCES "restaurant_customers"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_loyalty_accounts" ADD CONSTRAINT "tenant_loyalty_account_customerId_fk" FOREIGN KEY ("organizationId", "customerId") REFERENCES "restaurant_customers"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_loyalty_points_entries" ADD CONSTRAINT "tenant_loyalty_points_accountId_fk" FOREIGN KEY ("organizationId", "accountId") REFERENCES "restaurant_loyalty_accounts"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_loyalty_points_entries" ADD CONSTRAINT "tenant_loyalty_points_programVersionId_fk" FOREIGN KEY ("organizationId", "programVersionId") REFERENCES "restaurant_loyalty_program_versions"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_loyalty_points_entries" ADD CONSTRAINT "tenant_loyalty_points_billId_fk" FOREIGN KEY ("organizationId", "billId") REFERENCES "restaurant_bills"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_loyalty_points_entries" ADD CONSTRAINT "tenant_loyalty_points_refundId_fk" FOREIGN KEY ("organizationId", "refundId") REFERENCES "restaurant_refunds"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_loyalty_points_entries" ADD CONSTRAINT "tenant_loyalty_points_reversesEntryId_fk" FOREIGN KEY ("organizationId", "reversesEntryId") REFERENCES "restaurant_loyalty_points_entries"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_insight_daily_rollups" ADD CONSTRAINT "tenant_insight_daily_branchId_fk" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_insight_daily_rollups" ADD CONSTRAINT "tenant_insight_daily_closeId_fk" FOREIGN KEY ("organizationId", "sourceDailyCloseId") REFERENCES "restaurant_daily_closes"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_insight_item_mix_rollups" ADD CONSTRAINT "tenant_insight_item_branchId_fk" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_insight_item_mix_rollups" ADD CONSTRAINT "tenant_insight_item_productId_fk" FOREIGN KEY ("organizationId", "productId") REFERENCES "restaurant_products"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_insight_item_mix_rollups" ADD CONSTRAINT "tenant_insight_item_closeId_fk" FOREIGN KEY ("organizationId", "sourceDailyCloseId") REFERENCES "restaurant_daily_closes"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_labour_cost_facts" ADD CONSTRAINT "tenant_labour_cost_branchId_fk" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches"("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

-- Domain checks.
ALTER TABLE "restaurant_bills" ADD CONSTRAINT "restaurant_bills_discountTotal_nonneg_ck" CHECK ("discountTotal" >= 0);
ALTER TABLE "restaurant_customer_identifiers" ADD CONSTRAINT "restaurant_customer_identifiers_normalized_ck" CHECK ("normalizedValue" = btrim("normalizedValue") AND "normalizedValue" <> '' AND ("kind" <> 'EMAIL' OR "normalizedValue" = lower("normalizedValue")));
ALTER TABLE "restaurant_customer_interactions" ADD CONSTRAINT "restaurant_customer_interactions_values_ck" CHECK (btrim("type") <> '' AND btrim("idempotencyKey") <> '');
ALTER TABLE "restaurant_customer_tags" ADD CONSTRAINT "restaurant_customer_tags_name_ck" CHECK (btrim("name") <> '');
ALTER TABLE "restaurant_customer_consents" ADD CONSTRAINT "restaurant_customer_consents_provenance_ck" CHECK (btrim("source") <> '' AND btrim("actorId") <> '' AND btrim("policyVersion") <> '' AND btrim("idempotencyKey") <> '');
ALTER TABLE "restaurant_loyalty_program_versions" ADD CONSTRAINT "restaurant_loyalty_program_versions_values_ck" CHECK ("versionNumber" >= 1 AND "earnRate" >= 0 AND "redemptionValue" > 0 AND ("expiryDays" IS NULL OR "expiryDays" >= 1));
ALTER TABLE "restaurant_loyalty_accounts" ADD CONSTRAINT "restaurant_loyalty_accounts_active_ck" CHECK ("active" = ("deactivatedAt" IS NULL));
ALTER TABLE "restaurant_loyalty_points_entries" ADD CONSTRAINT "restaurant_loyalty_points_entries_points_ck" CHECK (("kind" = 'EARN' AND "points" > 0 AND "billId" IS NOT NULL) OR ("kind" = 'REDEEM' AND "points" < 0 AND "billId" IS NOT NULL) OR ("kind" IN ('REVERSAL', 'EXPIRY') AND "points" < 0) OR ("kind" = 'ADJUSTMENT' AND "points" <> 0));
ALTER TABLE "restaurant_loyalty_points_entries" ADD CONSTRAINT "restaurant_loyalty_points_entries_reference_ck" CHECK (("kind" <> 'REVERSAL' OR ("refundId" IS NOT NULL AND "reversesEntryId" IS NOT NULL)) AND ("kind" <> 'EXPIRY' OR "reversesEntryId" IS NOT NULL) AND ("kind" <> 'ADJUSTMENT' OR ("actorId" IS NOT NULL AND btrim("actorId") <> '' AND "reason" IS NOT NULL AND btrim("reason") <> '')) AND btrim("idempotencyKey") <> '');
ALTER TABLE "restaurant_insight_daily_rollups" ADD CONSTRAINT "restaurant_insight_daily_rollups_counts_ck" CHECK ("orderCount" >= 0 AND "coverCount" >= 0);
ALTER TABLE "restaurant_insight_item_mix_rollups" ADD CONSTRAINT "restaurant_insight_item_mix_rollups_quantity_ck" CHECK ("quantity" >= 0);
ALTER TABLE "restaurant_labour_cost_facts" ADD CONSTRAINT "restaurant_labour_cost_facts_values_ck" CHECK ("labourHours" >= 0 AND "labourCost" >= 0 AND btrim("source") <> '' AND btrim("idempotencyKey") <> '');

-- Effective loyalty versions are immutable at the database boundary.
CREATE FUNCTION prevent_effective_loyalty_program_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."effectiveFrom" <= clock_timestamp() THEN
    RAISE EXCEPTION 'effective loyalty program versions are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "restaurant_loyalty_program_versions_immutable"
BEFORE UPDATE OR DELETE ON "restaurant_loyalty_program_versions"
FOR EACH ROW EXECUTE FUNCTION prevent_effective_loyalty_program_version_mutation();

-- Normal CRUD tenant policies on eight mutable/rebuildable tables.
ALTER TABLE "restaurant_customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_customers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_customers" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_customer_identifiers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_customer_identifiers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_customer_identifiers" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_customer_tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_customer_tags" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_customer_tags" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_customer_tag_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_customer_tag_assignments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_customer_tag_assignments" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_loyalty_program_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_loyalty_program_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_loyalty_program_versions" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_loyalty_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_loyalty_accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_loyalty_accounts" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_insight_daily_rollups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_insight_daily_rollups" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_insight_daily_rollups" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_insight_item_mix_rollups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_insight_item_mix_rollups" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_insight_item_mix_rollups" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

-- Four append-only tables receive SELECT + INSERT policies only.
ALTER TABLE "restaurant_customer_interactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_customer_interactions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_customer_interactions" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_customer_interactions" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_customer_consents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_customer_consents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_customer_consents" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_customer_consents" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_loyalty_points_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_loyalty_points_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_loyalty_points_entries" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_loyalty_points_entries" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_labour_cost_facts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_labour_cost_facts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_labour_cost_facts" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_labour_cost_facts" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

-- Manual down migration (run only before dependent M8 lanes write data):
-- BEGIN;
-- DROP TRIGGER "restaurant_loyalty_program_versions_immutable" ON "restaurant_loyalty_program_versions";
-- DROP FUNCTION prevent_effective_loyalty_program_version_mutation();
-- ALTER TABLE "restaurant_orders" DROP CONSTRAINT "tenant_order_customerId_fk";
-- ALTER TABLE "restaurant_orders" DROP CONSTRAINT "restaurant_orders_customerId_fkey";
-- DROP TABLE "restaurant_loyalty_points_entries";
-- DROP TABLE "restaurant_loyalty_accounts";
-- DROP TABLE "restaurant_loyalty_program_versions";
-- DROP TABLE "restaurant_customer_consents";
-- DROP TABLE "restaurant_customer_tag_assignments";
-- DROP TABLE "restaurant_customer_tags";
-- DROP TABLE "restaurant_customer_interactions";
-- DROP TABLE "restaurant_customer_identifiers";
-- DROP TABLE "restaurant_insight_item_mix_rollups";
-- DROP TABLE "restaurant_insight_daily_rollups";
-- DROP TABLE "restaurant_labour_cost_facts";
-- DROP TABLE "restaurant_customers";
-- ALTER TABLE "restaurant_orders" DROP COLUMN "customerId";
-- ALTER TABLE "restaurant_bills" DROP CONSTRAINT "restaurant_bills_discountTotal_nonneg_ck";
-- ALTER TABLE "restaurant_bills" DROP COLUMN "discountTotal";
-- DROP TYPE "LoyaltyPointsEntryKind";
-- DROP TYPE "CustomerConsentChannel";
-- DROP TYPE "CustomerIdentifierKind";
-- COMMIT;
