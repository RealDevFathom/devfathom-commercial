-- CRM-L02 / CRM-L04: family retail accounts and explainable, owner-applied khata limits.
CREATE TYPE "PharmacyKhataEventKind" AS ENUM ('CHARGE', 'PAYMENT', 'DISHONOURED_CHEQUE');
CREATE TYPE "PharmacyKhataLimitDecisionKind" AS ENUM ('ACCEPTED', 'OVERRIDDEN');

CREATE TABLE "pharmacy_family_accounts" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "payerCustomerId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "creditLimitMinor" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_family_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_family_accounts_scope_key" UNIQUE ("organizationId", "branchId", "id"),
  CONSTRAINT "pharmacy_family_accounts_limit_check" CHECK ("creditLimitMinor" >= 0),
  CONSTRAINT "pharmacy_family_accounts_payer_fkey" FOREIGN KEY ("organizationId", "payerCustomerId")
    REFERENCES "pharmacy_customers" ("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_family_accounts_branch_fkey" FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "pharmacy_branches" ("organizationId", "id") ON DELETE RESTRICT
);
CREATE INDEX "pharmacy_family_accounts_payer_idx" ON "pharmacy_family_accounts" ("organizationId", "branchId", "payerCustomerId");

CREATE TABLE "pharmacy_family_members" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "familyAccountId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_family_members_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_family_members_scope_key" UNIQUE ("organizationId", "branchId", "id"),
  CONSTRAINT "pharmacy_family_members_account_customer_key" UNIQUE ("organizationId", "branchId", "familyAccountId", "customerId"),
  CONSTRAINT "pharmacy_family_members_account_fkey" FOREIGN KEY ("organizationId", "branchId", "familyAccountId")
    REFERENCES "pharmacy_family_accounts" ("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_family_members_customer_fkey" FOREIGN KEY ("organizationId", "customerId")
    REFERENCES "pharmacy_customers" ("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_family_members_branch_fkey" FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "pharmacy_branches" ("organizationId", "id") ON DELETE RESTRICT
);
CREATE INDEX "pharmacy_family_members_customer_idx" ON "pharmacy_family_members" ("organizationId", "customerId");

CREATE TABLE "pharmacy_khata_events" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "familyAccountId" TEXT NOT NULL,
  "memberId" TEXT,
  "kind" "PharmacyKhataEventKind" NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dueAt" TIMESTAMP(3),
  "settlesChargeId" TEXT,
  "actorId" TEXT NOT NULL,
  "note" TEXT,
  CONSTRAINT "pharmacy_khata_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_khata_events_scope_key" UNIQUE ("organizationId", "branchId", "id"),
  CONSTRAINT "pharmacy_khata_events_amount_check" CHECK ("amountMinor" > 0),
  CONSTRAINT "pharmacy_khata_events_shape_check" CHECK (
    ("kind" = 'CHARGE' AND "memberId" IS NOT NULL AND "dueAt" IS NOT NULL AND "settlesChargeId" IS NULL) OR
    ("kind" = 'PAYMENT' AND "memberId" IS NULL AND "dueAt" IS NULL AND "settlesChargeId" IS NOT NULL) OR
    ("kind" = 'DISHONOURED_CHEQUE' AND "memberId" IS NULL AND "dueAt" IS NULL)
  ),
  CONSTRAINT "pharmacy_khata_events_account_fkey" FOREIGN KEY ("organizationId", "branchId", "familyAccountId")
    REFERENCES "pharmacy_family_accounts" ("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_khata_events_member_fkey" FOREIGN KEY ("organizationId", "branchId", "memberId")
    REFERENCES "pharmacy_family_members" ("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_khata_events_charge_fkey" FOREIGN KEY ("organizationId", "branchId", "settlesChargeId")
    REFERENCES "pharmacy_khata_events" ("organizationId", "branchId", "id") ON DELETE RESTRICT
);
CREATE INDEX "pharmacy_khata_events_account_idx" ON "pharmacy_khata_events" ("organizationId", "branchId", "familyAccountId", "occurredAt");

CREATE TABLE "pharmacy_khata_limit_decisions" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "familyAccountId" TEXT NOT NULL,
  "kind" "PharmacyKhataLimitDecisionKind" NOT NULL,
  "score" INTEGER NOT NULL,
  "method" TEXT NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "windowEnd" TIMESTAMP(3) NOT NULL,
  "suggestedLimitMinor" INTEGER NOT NULL,
  "appliedLimitMinor" INTEGER NOT NULL,
  "reasons" JSONB NOT NULL,
  "ownerActorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_khata_limit_decisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_khata_limit_decisions_scope_key" UNIQUE ("organizationId", "branchId", "id"),
  CONSTRAINT "pharmacy_khata_limit_decisions_values_check" CHECK ("score" BETWEEN 0 AND 100 AND "suggestedLimitMinor" >= 0 AND "appliedLimitMinor" >= 0 AND "windowEnd" >= "windowStart"),
  CONSTRAINT "pharmacy_khata_limit_decisions_account_fkey" FOREIGN KEY ("organizationId", "branchId", "familyAccountId")
    REFERENCES "pharmacy_family_accounts" ("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_khata_limit_decisions_branch_fkey" FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "pharmacy_branches" ("organizationId", "id") ON DELETE RESTRICT
);
CREATE INDEX "pharmacy_khata_limit_decisions_account_idx" ON "pharmacy_khata_limit_decisions" ("organizationId", "branchId", "familyAccountId", "createdAt");

CREATE TRIGGER pharmacy_khata_events_append_only BEFORE UPDATE OR DELETE ON "pharmacy_khata_events"
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
CREATE TRIGGER pharmacy_khata_limit_decisions_append_only BEFORE UPDATE OR DELETE ON "pharmacy_khata_limit_decisions"
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'pharmacy_family_accounts', 'pharmacy_family_members', 'pharmacy_khata_events', 'pharmacy_khata_limit_decisions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_branch_isolation ON %I USING (current_setting(''app.is_platform_admin'', true) = ''true'' OR ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''') AND "branchId" = NULLIF(current_setting(''app.current_branch_id'', true), ''''))) WITH CHECK (current_setting(''app.is_platform_admin'', true) = ''true'' OR ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''') AND "branchId" = NULLIF(current_setting(''app.current_branch_id'', true), '''')))', table_name);
  END LOOP;
END $$;
