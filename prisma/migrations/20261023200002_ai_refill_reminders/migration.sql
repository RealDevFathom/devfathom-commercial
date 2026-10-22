-- Owner-approved, AI-drafted refill reminders derived from retail purchase cadence.
CREATE TABLE "pharmacy_ai_refill_settings" (
  "organizationId" TEXT PRIMARY KEY,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "leadDays" INTEGER NOT NULL DEFAULT 3,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_ai_refill_settings_lead_check" CHECK ("leadDays" BETWEEN 0 AND 30),
  CONSTRAINT "pharmacy_ai_refill_settings_org_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE TABLE "pharmacy_ai_refill_reminders" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "medicineId" TEXT NOT NULL,
  "medicineName" TEXT NOT NULL,
  "medianIntervalDays" INTEGER NOT NULL,
  "lastPurchasedAt" TIMESTAMP(3) NOT NULL,
  "reminderAt" TIMESTAMP(3) NOT NULL,
  "draftText" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "aiModel" TEXT NOT NULL,
  "aiTier" TEXT NOT NULL DEFAULT 'standard',
  "approvedByUserId" TEXT,
  "approvedAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_ai_refill_reminders_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "pharmacy_ai_refill_reminders_cycle_key" UNIQUE ("organizationId", "customerId", "medicineId", "lastPurchasedAt"),
  CONSTRAINT "pharmacy_ai_refill_reminders_cadence_check" CHECK ("medianIntervalDays" > 0),
  CONSTRAINT "pharmacy_ai_refill_reminders_status_check" CHECK ("status" IN ('DRAFT','APPROVED','SKIPPED','SENT')),
  CONSTRAINT "pharmacy_ai_refill_reminders_tier_check" CHECK ("aiTier" = 'standard'),
  CONSTRAINT "pharmacy_ai_refill_reminders_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_ai_refill_reminders_customer_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "pharmacy_customers"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_ai_refill_reminders_medicine_fkey" FOREIGN KEY ("organizationId", "medicineId") REFERENCES "pharmacy_medicines"("organizationId", "id") ON DELETE RESTRICT
);

CREATE INDEX "pharmacy_ai_refill_reminders_org_due_idx" ON "pharmacy_ai_refill_reminders"("organizationId", "status", "reminderAt");

ALTER TABLE "pharmacy_ai_refill_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_ai_refill_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pharmacy_ai_refill_settings" USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "pharmacy_ai_refill_reminders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_ai_refill_reminders" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pharmacy_ai_refill_reminders" USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
