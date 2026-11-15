-- DEV-73: chronic refill program and monthly pack subscription.
--
-- A subscription names one pack of one medicine for one retail customer. Each
-- cycle holds its stock through DEM-03 restock reservations (campaign key
-- `refill-cycle:<cycleId>`), so every existing availability check already
-- excludes it. A prescription-only cycle cannot reach checkout until a
-- pharmacist approves that cycle with a fresh PIN; the CHECK below enforces it.
BEGIN;

DO $$ BEGIN
  CREATE TYPE "PharmacyRefillSubscriptionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "PharmacyRefillSubscriptionPayment" AS ENUM ('PREPAY', 'KHATA');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "PharmacyRefillCycleStatus" AS ENUM ('AWAITING_PHARMACIST', 'RESERVED', 'CHECKOUT_STARTED', 'RELEASED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "pharmacy_refill_subscriptions" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "medicineId" TEXT NOT NULL,
  "presentationId" TEXT NOT NULL,
  "packLevelId" TEXT NOT NULL,
  "packsPerCycle" INTEGER NOT NULL,
  "cycleDays" INTEGER NOT NULL,
  "reminderLeadDays" INTEGER NOT NULL,
  "fulfillment" "PharmacyCustomerOrderFulfillment" NOT NULL,
  "paymentMode" "PharmacyRefillSubscriptionPayment" NOT NULL,
  "nextDueAt" TIMESTAMP(3) NOT NULL,
  "status" "PharmacyRefillSubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdByUserId" TEXT NOT NULL,
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_refill_subscriptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_refill_subscriptions_packs_ck" CHECK ("packsPerCycle" BETWEEN 1 AND 100),
  CONSTRAINT "pharmacy_refill_subscriptions_cycle_ck" CHECK ("cycleDays" BETWEEN 1 AND 180),
  CONSTRAINT "pharmacy_refill_subscriptions_lead_ck" CHECK ("reminderLeadDays" BETWEEN 0 AND 30),
  CONSTRAINT "pharmacy_refill_subscriptions_cancel_ck" CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS "pharmacy_refill_subscription_cycles" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "canonicalUnits" INTEGER NOT NULL,
  "requiresPharmacist" BOOLEAN NOT NULL,
  "status" "PharmacyRefillCycleStatus" NOT NULL,
  "openedByUserId" TEXT NOT NULL,
  "approvedByUserId" TEXT,
  "approvalPolicy" TEXT,
  "approvalCredentialId" TEXT,
  "selfApproved" BOOLEAN NOT NULL DEFAULT false,
  "approvedAt" TIMESTAMP(3),
  "counterSaleId" TEXT,
  "releasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_refill_subscription_cycles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_refill_cycles_units_ck" CHECK ("canonicalUnits" > 0),
  -- An Rx cycle past AWAITING_PHARMACIST must carry the pharmacist's approval.
  CONSTRAINT "pharmacy_refill_cycles_rx_approval_ck" CHECK (
    NOT "requiresPharmacist"
    OR "status" IN ('AWAITING_PHARMACIST', 'RELEASED')
    OR ("approvedByUserId" IS NOT NULL AND "approvalPolicy" IS NOT NULL AND "approvedAt" IS NOT NULL)
  ),
  CONSTRAINT "pharmacy_refill_cycles_checkout_ck" CHECK (("status" = 'CHECKOUT_STARTED') = ("counterSaleId" IS NOT NULL)),
  CONSTRAINT "pharmacy_refill_cycles_release_ck" CHECK (("status" = 'RELEASED') = ("releasedAt" IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_refill_subscriptions_organizationId_id_key" ON "pharmacy_refill_subscriptions"("organizationId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_refill_subscriptions_organizationId_branchId_id_key" ON "pharmacy_refill_subscriptions"("organizationId", "branchId", "id");
CREATE INDEX IF NOT EXISTS "pharmacy_refill_subscriptions_organizationId_branchId_status_nextDueAt_idx" ON "pharmacy_refill_subscriptions"("organizationId", "branchId", "status", "nextDueAt");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_refill_subscription_cycles_organizationId_id_key" ON "pharmacy_refill_subscription_cycles"("organizationId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_refill_subscription_cycles_organizationId_subscriptionId_dueAt_key" ON "pharmacy_refill_subscription_cycles"("organizationId", "subscriptionId", "dueAt");
CREATE INDEX IF NOT EXISTS "pharmacy_refill_subscription_cycles_organizationId_branchId_status_dueAt_idx" ON "pharmacy_refill_subscription_cycles"("organizationId", "branchId", "status", "dueAt");

DO $$ BEGIN
  ALTER TABLE "pharmacy_refill_subscriptions" ADD CONSTRAINT "pharmacy_refill_subscriptions_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "pharmacy_refill_subscriptions" ADD CONSTRAINT "pharmacy_refill_subscriptions_customer_id_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "pharmacy_customers"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "pharmacy_refill_subscriptions" ADD CONSTRAINT "pharmacy_refill_subscriptions_medicine_fkey" FOREIGN KEY ("organizationId", "medicineId") REFERENCES "pharmacy_medicines"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "pharmacy_refill_subscriptions" ADD CONSTRAINT "pharmacy_refill_subscriptions_presentation_fkey" FOREIGN KEY ("presentationId") REFERENCES "pharmacy_presentations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "pharmacy_refill_subscriptions" ADD CONSTRAINT "pharmacy_refill_subscriptions_pack_level_fkey" FOREIGN KEY ("packLevelId") REFERENCES "pharmacy_pack_levels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "pharmacy_refill_subscriptions" ADD CONSTRAINT "pharmacy_refill_subscriptions_created_by_fkey" FOREIGN KEY ("organizationId", "createdByUserId") REFERENCES "users"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "pharmacy_refill_subscription_cycles" ADD CONSTRAINT "pharmacy_refill_subscription_cycles_subscription_fkey" FOREIGN KEY ("organizationId", "branchId", "subscriptionId") REFERENCES "pharmacy_refill_subscriptions"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "pharmacy_refill_subscription_cycles" ADD CONSTRAINT "pharmacy_refill_subscription_cycles_opened_by_fkey" FOREIGN KEY ("organizationId", "openedByUserId") REFERENCES "users"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "pharmacy_refill_subscription_cycles" ADD CONSTRAINT "pharmacy_refill_subscription_cycles_approved_by_fkey" FOREIGN KEY ("organizationId", "approvedByUserId") REFERENCES "users"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "pharmacy_refill_subscription_cycles" ADD CONSTRAINT "pharmacy_refill_subscription_cycles_counter_sale_fkey" FOREIGN KEY ("organizationId", "branchId", "counterSaleId") REFERENCES "pharmacy_sales"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Branch-scoped tenant tables, the same boundary as the DEM-03 reservations
-- they drive. Neither table has a DELETE policy.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_refill_subscriptions','pharmacy_refill_subscription_cycles'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_branch_select ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_branch_insert ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_branch_update ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS platform_reminder_scan ON %I', t);
    EXECUTE format('CREATE POLICY tenant_branch_select ON %I FOR SELECT USING ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''') AND "branchId" = NULLIF(current_setting(''app.current_branch_id'', true), ''''))', t);
    EXECUTE format('CREATE POLICY tenant_branch_insert ON %I FOR INSERT WITH CHECK ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''') AND "branchId" = NULLIF(current_setting(''app.current_branch_id'', true), ''''))', t);
    EXECUTE format('CREATE POLICY tenant_branch_update ON %I FOR UPDATE USING ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''') AND "branchId" = NULLIF(current_setting(''app.current_branch_id'', true), '''')) WITH CHECK ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''') AND "branchId" = NULLIF(current_setting(''app.current_branch_id'', true), ''''))', t);
    -- The scheduled reminder job scans due cycles across tenants read-only,
    -- as the RX-07 reminder captures already allow.
    EXECUTE format('CREATE POLICY platform_reminder_scan ON %I FOR SELECT USING (current_setting(''app.is_platform_admin'', true) = ''true'')', t);
  END LOOP;
END $$;

COMMIT;
