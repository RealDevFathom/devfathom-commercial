-- #743: recurring chronic refill packs. Clinical approval remains per-cycle.
CREATE TYPE "PharmacyChronicRefillPayment" AS ENUM ('PREPAY', 'KHATA');

CREATE TABLE "pharmacy_chronic_refill_subscriptions" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "medicineId" TEXT NOT NULL,
  "presentationId" TEXT NOT NULL,
  "packLevelId" TEXT NOT NULL,
  "quantityPacks" INTEGER NOT NULL,
  "prescriptionLineId" TEXT,
  "fulfillment" "PharmacyCustomerOrderFulfillment" NOT NULL,
  "paymentMode" "PharmacyChronicRefillPayment" NOT NULL,
  "addressLine" TEXT,
  "city" TEXT,
  "deliveryInstructions" TEXT,
  "cadenceDays" INTEGER NOT NULL,
  "nextDueAt" TIMESTAMP(3) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_chronic_refill_subscriptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_chronic_refill_subscription_scope_key" UNIQUE ("organizationId", "branchId", "id"),
  CONSTRAINT "pharmacy_chronic_refill_subscription_quantity_check" CHECK ("quantityPacks" > 0 AND "cadenceDays" > 0),
  CONSTRAINT "pharmacy_chronic_refill_subscription_fulfillment_check" CHECK (
    ("fulfillment" = 'DELIVER' AND "addressLine" IS NOT NULL AND "city" IS NOT NULL) OR
    ("fulfillment" = 'COLLECT' AND "addressLine" IS NULL AND "city" IS NULL AND "deliveryInstructions" IS NULL)
  ),
  CONSTRAINT "pharmacy_chronic_refill_subscription_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_chronic_refill_subscription_customer_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "pharmacy_customers"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_chronic_refill_subscription_medicine_fkey" FOREIGN KEY ("organizationId", "medicineId") REFERENCES "pharmacy_medicines"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_chronic_refill_subscription_prescription_fkey" FOREIGN KEY ("organizationId", "prescriptionLineId") REFERENCES "pharmacy_prescription_lines"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_chronic_refill_subscription_user_fkey" FOREIGN KEY ("organizationId", "createdByUserId") REFERENCES "users"("organizationId", "id") ON DELETE RESTRICT
);

CREATE INDEX "pharmacy_chronic_refill_subscription_due_idx" ON "pharmacy_chronic_refill_subscriptions" ("organizationId", "branchId", "active", "nextDueAt");

CREATE TABLE "pharmacy_chronic_refill_cycles" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "orderId" TEXT NOT NULL,
  "pharmacistDecisionId" TEXT,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_chronic_refill_cycles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_chronic_refill_cycle_once_key" UNIQUE ("organizationId", "branchId", "subscriptionId", "dueAt"),
  CONSTRAINT "pharmacy_chronic_refill_cycle_approval_once_key" UNIQUE ("organizationId", "pharmacistDecisionId"),
  CONSTRAINT "pharmacy_chronic_refill_cycle_subscription_fkey" FOREIGN KEY ("organizationId", "branchId", "subscriptionId") REFERENCES "pharmacy_chronic_refill_subscriptions"("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_chronic_refill_cycle_order_fkey" FOREIGN KEY ("organizationId", "branchId", "orderId") REFERENCES "pharmacy_customer_orders"("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_chronic_refill_cycle_pharmacist_fkey" FOREIGN KEY ("organizationId", "pharmacistDecisionId") REFERENCES "pharmacy_pharmacist_review_decisions"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_chronic_refill_cycle_user_fkey" FOREIGN KEY ("organizationId", "createdByUserId") REFERENCES "users"("organizationId", "id") ON DELETE RESTRICT
);

CREATE INDEX "pharmacy_chronic_refill_cycle_order_idx" ON "pharmacy_chronic_refill_cycles" ("organizationId", "branchId", "orderId");

ALTER TABLE "pharmacy_chronic_refill_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_chronic_refill_subscriptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pharmacy_chronic_refill_subscriptions"
  USING ("organizationId" = current_setting('app.current_organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));
ALTER TABLE "pharmacy_chronic_refill_cycles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_chronic_refill_cycles" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pharmacy_chronic_refill_cycles"
  USING ("organizationId" = current_setting('app.current_organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

CREATE TRIGGER pharmacy_chronic_refill_cycles_append_only
  BEFORE UPDATE OR DELETE ON "pharmacy_chronic_refill_cycles"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
