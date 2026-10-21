-- CRM-L01 / RX-01: consent-gated pharmacy retail identity and loyalty ledger.
ALTER TYPE "PharmacyTenderType" ADD VALUE 'LOYALTY';
CREATE TYPE "PharmacyLoyaltyEntryKind" AS ENUM ('EARN', 'REDEEM', 'REFUND');
ALTER TYPE "FinanceAccountCode" ADD VALUE 'LOYALTY_REDEMPTION';

CREATE TABLE "pharmacy_customers" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "patientId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "phoneLast4" TEXT,
  "creditLimitMinor" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_customers_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "pharmacy_customers_patient_fkey" FOREIGN KEY ("organizationId", "patientId")
    REFERENCES "pharmacy_patients" ("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_customers_credit_limit_check" CHECK ("creditLimitMinor" >= 0),
  CONSTRAINT "pharmacy_customers_phone_last4_check" CHECK ("phoneLast4" IS NULL OR "phoneLast4" ~ '^[0-9]{4}$')
);
CREATE UNIQUE INDEX "pharmacy_customers_org_patient_key"
  ON "pharmacy_customers" ("organizationId", "patientId");
CREATE INDEX "pharmacy_customers_org_name_idx"
  ON "pharmacy_customers" ("organizationId", "displayName");

ALTER TABLE "pharmacy_sales" ADD COLUMN "customerId" TEXT;
ALTER TABLE "pharmacy_sales" ADD CONSTRAINT "pharmacy_sales_customer_fkey"
  FOREIGN KEY ("organizationId", "customerId")
  REFERENCES "pharmacy_customers" ("organizationId", "id") ON DELETE RESTRICT;

CREATE TABLE "pharmacy_loyalty_points_entries" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "tenderId" TEXT,
  "refundId" TEXT,
  "kind" "PharmacyLoyaltyEntryKind" NOT NULL,
  "points" INTEGER NOT NULL,
  "requestedPoints" INTEGER,
  "netPaidMinor" INTEGER,
  "actorId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_loyalty_points_entries_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "pharmacy_loyalty_points_entries_org_idempotency_key" UNIQUE ("organizationId", "idempotencyKey"),
  CONSTRAINT "pharmacy_loyalty_points_entries_customer_fkey" FOREIGN KEY ("organizationId", "customerId")
    REFERENCES "pharmacy_customers" ("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_loyalty_points_entries_sale_fkey" FOREIGN KEY ("organizationId", "branchId", "saleId")
    REFERENCES "pharmacy_sales" ("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_loyalty_points_entries_tender_fkey" FOREIGN KEY ("organizationId", "tenderId")
    REFERENCES "pharmacy_tenders" ("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_loyalty_points_entries_refund_fkey" FOREIGN KEY ("organizationId", "refundId")
    REFERENCES "pharmacy_refunds" ("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_loyalty_points_entries_sign_check" CHECK (
    ("kind" = 'EARN' AND "points" > 0 AND "requestedPoints" IS NULL AND "netPaidMinor" >= 0 AND "tenderId" IS NULL AND "refundId" IS NULL) OR
    ("kind" = 'REDEEM' AND "points" < 0 AND "requestedPoints" > 0 AND "netPaidMinor" IS NULL AND "tenderId" IS NOT NULL AND "refundId" IS NULL) OR
    ("kind" = 'REFUND' AND "points" > 0 AND "requestedPoints" IS NULL AND "netPaidMinor" IS NULL AND "tenderId" IS NOT NULL AND "refundId" IS NOT NULL)
  )
);
CREATE INDEX "pharmacy_loyalty_points_entries_scope_idx"
  ON "pharmacy_loyalty_points_entries" ("organizationId", "branchId", "customerId", "occurredAt");
CREATE INDEX "pharmacy_loyalty_points_entries_sale_idx"
  ON "pharmacy_loyalty_points_entries" ("organizationId", "saleId");
CREATE INDEX "pharmacy_loyalty_points_entries_refund_idx"
  ON "pharmacy_loyalty_points_entries" ("organizationId", "refundId");

CREATE TRIGGER pharmacy_loyalty_points_entries_append_only
BEFORE UPDATE OR DELETE ON "pharmacy_loyalty_points_entries"
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();

ALTER TABLE "pharmacy_customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_customers" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pharmacy_customers"
  USING (current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "pharmacy_loyalty_points_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_loyalty_points_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_branch_isolation ON "pharmacy_loyalty_points_entries"
  USING (current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
      "branchId" = current_setting('app.current_branch_id', true))))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
      "branchId" = current_setting('app.current_branch_id', true))));
