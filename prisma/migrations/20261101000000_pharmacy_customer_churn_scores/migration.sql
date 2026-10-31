-- #729 — nightly RFM churn score per pharmacy customer, exposed to marketing segments.
-- Inputs are retail-only aggregates (receipt recency, receipt frequency and net line
-- value). No clinical, prescription or medicine data is stored here.
CREATE TABLE "pharmacy_customer_churn_scores" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "businessDate" TEXT NOT NULL,
  "modelVersion" INTEGER NOT NULL,
  "recencyDays" INTEGER NOT NULL,
  "frequency" INTEGER NOT NULL,
  "monetaryMinor" BIGINT NOT NULL,
  "recencyScore" INTEGER NOT NULL,
  "frequencyScore" INTEGER NOT NULL,
  "monetaryScore" INTEGER NOT NULL,
  "churnScore" INTEGER NOT NULL,
  "riskBand" TEXT NOT NULL,
  "scoredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_customer_churn_scores_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_customer_churn_scores_business_date_check" CHECK ("businessDate" ~ '^\d{4}-\d{2}-\d{2}$'),
  CONSTRAINT "pharmacy_customer_churn_scores_values_check" CHECK (
    "modelVersion" >= 1 AND "recencyDays" >= 0 AND "frequency" >= 0 AND "monetaryMinor" >= 0
    AND "recencyScore" BETWEEN 1 AND 5 AND "frequencyScore" BETWEEN 1 AND 5
    AND "monetaryScore" BETWEEN 1 AND 5 AND "churnScore" BETWEEN 0 AND 100
  ),
  CONSTRAINT "pharmacy_customer_churn_scores_band_check" CHECK ("riskBand" IN ('LOW', 'MEDIUM', 'HIGH')),
  CONSTRAINT "pharmacy_customer_churn_scores_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "pharmacy_customer_churn_scores_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE CASCADE,
  CONSTRAINT "pharmacy_customer_churn_scores_customer_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "pharmacy_customers"("organizationId", "id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "pharmacy_customer_churn_scores_organizationId_id_key" ON "pharmacy_customer_churn_scores"("organizationId", "id");
CREATE UNIQUE INDEX "pharmacy_customer_churn_scores_customer_key" ON "pharmacy_customer_churn_scores"("organizationId", "branchId", "customerId");
CREATE INDEX "pharmacy_customer_churn_scores_score_idx" ON "pharmacy_customer_churn_scores"("organizationId", "branchId", "churnScore");

CREATE TABLE "pharmacy_churn_scoring_runs" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "businessDate" TEXT NOT NULL,
  "modelVersion" INTEGER NOT NULL,
  "scoredCustomers" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_churn_scoring_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_churn_scoring_runs_business_date_check" CHECK ("businessDate" ~ '^\d{4}-\d{2}-\d{2}$'),
  CONSTRAINT "pharmacy_churn_scoring_runs_values_check" CHECK ("modelVersion" >= 1 AND "scoredCustomers" >= 0),
  CONSTRAINT "pharmacy_churn_scoring_runs_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "pharmacy_churn_scoring_runs_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "pharmacy_churn_scoring_runs_organizationId_id_key" ON "pharmacy_churn_scoring_runs"("organizationId", "id");
CREATE UNIQUE INDEX "pharmacy_churn_scoring_runs_daily_key" ON "pharmacy_churn_scoring_runs"("organizationId", "branchId", "businessDate");

-- Both tables are tenant + branch scoped, matching the marketing segment tables
-- whose campaigns consume these scores.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_customer_churn_scores','pharmacy_churn_scoring_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_branch_isolation ON %I USING ((current_setting(''app.is_platform_admin'', true) = ''true'') OR ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''') AND (NULLIF(current_setting(''app.current_branch_id'', true), '''') IS NULL OR "branchId" = NULLIF(current_setting(''app.current_branch_id'', true), '''')))) WITH CHECK ((current_setting(''app.is_platform_admin'', true) = ''true'') OR ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''') AND (NULLIF(current_setting(''app.current_branch_id'', true), '''') IS NULL OR "branchId" = NULLIF(current_setting(''app.current_branch_id'', true), ''''))))', t);
  END LOOP;
END $$;
