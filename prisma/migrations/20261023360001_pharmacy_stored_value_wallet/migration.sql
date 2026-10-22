CREATE TYPE "StoredValueAccountKind" AS ENUM ('CUSTOMER_LIABILITY', 'CASH_CLEARING', 'SALES_CLEARING');
CREATE TYPE "StoredValueEntryKind" AS ENUM ('TOP_UP', 'SPEND', 'REFUND', 'EXPIRY', 'ADJUSTMENT');

CREATE TABLE "stored_value_accounts" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "customerId" TEXT, "kind" "StoredValueAccountKind" NOT NULL, "currency" TEXT NOT NULL DEFAULT 'PKR',
  "balanceMinor" INTEGER NOT NULL DEFAULT 0, "cnicLast4" TEXT, "cnicHmac" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "stored_value_accounts_balance_check" CHECK ("kind" <> 'CUSTOMER_LIABILITY' OR "balanceMinor" >= 0),
  CONSTRAINT "stored_value_accounts_cnic_last4_check" CHECK ("cnicLast4" IS NULL OR "cnicLast4" ~ '^[0-9]{4}$'),
  CONSTRAINT "stored_value_accounts_no_full_cnic_check" CHECK ("cnicHmac" IS NULL OR length("cnicHmac") = 64)
);
CREATE UNIQUE INDEX "stored_value_accounts_org_id_key" ON "stored_value_accounts"("organizationId", "id");
CREATE UNIQUE INDEX "stored_value_accounts_org_customer_kind_key" ON "stored_value_accounts"("organizationId", "customerId", "kind");
CREATE INDEX "stored_value_accounts_org_kind_idx" ON "stored_value_accounts"("organizationId", "kind");

CREATE TABLE "stored_value_journals" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT, "kind" "StoredValueEntryKind" NOT NULL, "idempotencyKey" TEXT NOT NULL,
  "saleId" TEXT, "actorId" TEXT NOT NULL, "tender" "PharmacyTenderType", "reason" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stored_value_journals_adjustment_reason_check" CHECK ("kind" <> 'ADJUSTMENT' OR length(trim("reason")) > 0),
  CONSTRAINT "stored_value_journals_topup_attribution_check" CHECK ("kind" <> 'TOP_UP' OR ("branchId" IS NOT NULL AND "tender" IS NOT NULL))
);
CREATE UNIQUE INDEX "stored_value_journals_org_id_key" ON "stored_value_journals"("organizationId", "id");
CREATE UNIQUE INDEX "stored_value_journals_org_idempotency_key" ON "stored_value_journals"("organizationId", "idempotencyKey");
CREATE INDEX "stored_value_journals_org_branch_occurred_idx" ON "stored_value_journals"("organizationId", "branchId", "occurredAt");

CREATE TABLE "stored_value_entries" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "journalId" TEXT NOT NULL, "accountId" TEXT NOT NULL, "amountMinor" INTEGER NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stored_value_entries_nonzero_check" CHECK ("amountMinor" <> 0),
  CONSTRAINT "stored_value_entries_journal_fkey" FOREIGN KEY ("organizationId", "journalId") REFERENCES "stored_value_journals"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "stored_value_entries_account_fkey" FOREIGN KEY ("organizationId", "accountId") REFERENCES "stored_value_accounts"("organizationId", "id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "stored_value_entries_org_id_key" ON "stored_value_entries"("organizationId", "id");
CREATE UNIQUE INDEX "stored_value_entries_org_journal_account_key" ON "stored_value_entries"("organizationId", "journalId", "accountId");
CREATE INDEX "stored_value_entries_statement_idx" ON "stored_value_entries"("organizationId", "accountId", "occurredAt", "id");

CREATE TABLE "pharmacy_wallet_tiers" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true), "name" TEXT NOT NULL,
 "qualifyingTopUpMinor" INTEGER NOT NULL, "discountBps" INTEGER NOT NULL, "sortOrder" INTEGER NOT NULL, "active" BOOLEAN NOT NULL DEFAULT true,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "pharmacy_wallet_tiers_values_check" CHECK ("qualifyingTopUpMinor" > 0 AND "discountBps" BETWEEN 0 AND 10000)
);
CREATE UNIQUE INDEX "pharmacy_wallet_tiers_org_id_key" ON "pharmacy_wallet_tiers"("organizationId", "id");
CREATE UNIQUE INDEX "pharmacy_wallet_tiers_org_name_key" ON "pharmacy_wallet_tiers"("organizationId", "name");
CREATE INDEX "pharmacy_wallet_tiers_threshold_idx" ON "pharmacy_wallet_tiers"("organizationId", "qualifyingTopUpMinor");

CREATE TABLE "pharmacy_wallet_settings" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
 "expiryDays" INTEGER, "allowUnusedRefund" BOOLEAN NOT NULL DEFAULT false, "allowBenefitStacking" BOOLEAN NOT NULL DEFAULT false,
 "requireOtp" BOOLEAN NOT NULL DEFAULT false, "cnicFailureLimit" INTEGER NOT NULL DEFAULT 5, "cnicLockoutMinutes" INTEGER NOT NULL DEFAULT 15,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "pharmacy_wallet_settings_values_check" CHECK (("expiryDays" IS NULL OR "expiryDays" > 0) AND "cnicFailureLimit" > 0 AND "cnicLockoutMinutes" > 0)
);
CREATE UNIQUE INDEX "pharmacy_wallet_settings_org_key" ON "pharmacy_wallet_settings"("organizationId");
CREATE UNIQUE INDEX "pharmacy_wallet_settings_org_id_key" ON "pharmacy_wallet_settings"("organizationId", "id");

CREATE TABLE "pharmacy_wallet_audits" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true), "actorId" TEXT NOT NULL,
 "action" TEXT NOT NULL, "oldValue" JSONB, "newValue" JSONB, "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "pharmacy_wallet_audits_org_id_key" ON "pharmacy_wallet_audits"("organizationId", "id");
CREATE INDEX "pharmacy_wallet_audits_org_occurred_idx" ON "pharmacy_wallet_audits"("organizationId", "occurredAt");

CREATE TABLE "pharmacy_wallet_cnic_failures" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
 "customerId" TEXT NOT NULL, "cashierId" TEXT NOT NULL, "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "pharmacy_wallet_cnic_failures_org_id_key" ON "pharmacy_wallet_cnic_failures"("organizationId", "id");
CREATE INDEX "pharmacy_wallet_cnic_failures_customer_idx" ON "pharmacy_wallet_cnic_failures"("organizationId", "customerId", "occurredAt");
CREATE INDEX "pharmacy_wallet_cnic_failures_cashier_idx" ON "pharmacy_wallet_cnic_failures"("organizationId", "cashierId", "occurredAt");

-- Journal and postings are permanent evidence, as are failed identity checks and policy audits.
CREATE FUNCTION stored_value_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'stored-value ledger is append-only'; END $$;
CREATE TRIGGER stored_value_journals_immutable BEFORE UPDATE OR DELETE ON "stored_value_journals" FOR EACH ROW EXECUTE FUNCTION stored_value_reject_mutation();
CREATE TRIGGER stored_value_entries_immutable BEFORE UPDATE OR DELETE ON "stored_value_entries" FOR EACH ROW EXECUTE FUNCTION stored_value_reject_mutation();
CREATE TRIGGER pharmacy_wallet_audits_immutable BEFORE UPDATE OR DELETE ON "pharmacy_wallet_audits" FOR EACH ROW EXECUTE FUNCTION stored_value_reject_mutation();
CREATE TRIGGER pharmacy_wallet_cnic_failures_immutable BEFORE UPDATE OR DELETE ON "pharmacy_wallet_cnic_failures" FOR EACH ROW EXECUTE FUNCTION stored_value_reject_mutation();

CREATE FUNCTION stored_value_assert_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_org TEXT; target_journal TEXT; total BIGINT; posting_count BIGINT;
BEGIN
 target_org := COALESCE(NEW."organizationId", OLD."organizationId"); target_journal := COALESCE(NEW."journalId", OLD."journalId");
 SELECT COALESCE(sum("amountMinor"),0), count(*) INTO total, posting_count FROM "stored_value_entries" WHERE "organizationId"=target_org AND "journalId"=target_journal;
 IF total <> 0 OR posting_count < 2 THEN RAISE EXCEPTION 'unbalanced stored-value journal %', target_journal; END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER stored_value_entries_balanced AFTER INSERT ON "stored_value_entries" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stored_value_assert_balanced();

CREATE VIEW "stored_value_customer_statements" AS
 SELECT e."organizationId", e."accountId", e."journalId", j."kind", j."branchId", j."saleId", j."actorId", j."reason", e."amountMinor", e."occurredAt",
 sum(e."amountMinor") OVER (PARTITION BY e."organizationId", e."accountId" ORDER BY e."occurredAt", e."id")::bigint AS "runningBalanceMinor"
 FROM "stored_value_entries" e JOIN "stored_value_journals" j ON j."organizationId"=e."organizationId" AND j."id"=e."journalId";

DO $$ DECLARE tab TEXT; BEGIN
 FOREACH tab IN ARRAY ARRAY['stored_value_accounts','stored_value_journals','stored_value_entries','pharmacy_wallet_tiers','pharmacy_wallet_settings','pharmacy_wallet_audits','pharmacy_wallet_cnic_failures'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tab); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tab);
  EXECUTE format('CREATE POLICY %I ON %I USING ("organizationId" = current_setting(''app.current_organization_id'', true)) WITH CHECK ("organizationId" = current_setting(''app.current_organization_id'', true))', tab || '_tenant_isolation', tab);
 END LOOP;
END $$;

-- Seeded lazily per tenant by the application; these are the product defaults.
COMMENT ON TABLE "pharmacy_wallet_tiers" IS 'Defaults: Bronze 2000000/200bps, Silver 5000000/500bps, Gold 10000000/1000bps';
