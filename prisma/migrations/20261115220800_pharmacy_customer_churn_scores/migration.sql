-- DEV-83: nightly RFM-based churn score per pharmacy customer and branch.
BEGIN;

CREATE TABLE IF NOT EXISTS "pharmacy_customer_churn_scores" (
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "score" INTEGER NOT NULL,
  "recencyScore" INTEGER NOT NULL,
  "frequencyScore" INTEGER NOT NULL,
  "monetaryScore" INTEGER NOT NULL,
  "daysSinceLastReceipt" INTEGER NOT NULL,
  "receiptCount" INTEGER NOT NULL,
  "monetaryMinor" BIGINT NOT NULL,
  "businessDate" DATE NOT NULL,
  "computedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_customer_churn_scores_pkey" PRIMARY KEY ("organizationId", "branchId", "customerId"),
  CONSTRAINT "pharmacy_customer_churn_scores_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_customer_churn_scores_customer_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "pharmacy_customers"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_customer_churn_scores_range_check" CHECK (
    "score" BETWEEN 0 AND 100
    AND "recencyScore" BETWEEN 1 AND 5
    AND "frequencyScore" BETWEEN 1 AND 5
    AND "monetaryScore" BETWEEN 1 AND 5
    AND "daysSinceLastReceipt" >= 0
    AND "receiptCount" >= 0
    AND "monetaryMinor" >= 0
  )
);

CREATE INDEX IF NOT EXISTS "pharmacy_customer_churn_scores_branch_score_idx"
  ON "pharmacy_customer_churn_scores"("organizationId", "branchId", "score");

CREATE TABLE IF NOT EXISTS "pharmacy_churn_scoring_runs" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "businessDate" DATE NOT NULL,
  "customersScored" INTEGER NOT NULL,
  "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_churn_scoring_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_churn_scoring_runs_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_churn_scoring_runs_count_check" CHECK ("customersScored" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_churn_scoring_runs_organizationId_businessDate_key"
  ON "pharmacy_churn_scoring_runs"("organizationId", "businessDate");

ALTER TABLE "pharmacy_customer_churn_scores" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_customer_churn_scores" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_branch_isolation ON "pharmacy_customer_churn_scores";
CREATE POLICY tenant_branch_isolation ON "pharmacy_customer_churn_scores"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR (
      "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
      AND (
        NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
        OR "branchId" = current_setting('app.current_branch_id', true)
      )
    )
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR (
      "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
      AND (
        NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
        OR "branchId" = current_setting('app.current_branch_id', true)
      )
    )
  );

ALTER TABLE "pharmacy_churn_scoring_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_churn_scoring_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "pharmacy_churn_scoring_runs";
CREATE POLICY tenant_isolation ON "pharmacy_churn_scoring_runs"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

COMMIT;
