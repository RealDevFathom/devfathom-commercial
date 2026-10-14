-- M8 correction D: make organization-wide loyalty liability a dated fact rather
-- than duplicating it into every branch-day rollup. Existing branch data remains
-- readable; the projection version forces a safe rebuild before replay is trusted.

ALTER TABLE "restaurant_insight_daily_rollups"
  ADD COLUMN "projectionVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "restaurant_insight_item_mix_rollups"
  ADD COLUMN "projectionVersion" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "restaurant_insight_loyalty_liabilities" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "businessDate" DATE NOT NULL,
  "cutoffAt" TIMESTAMP(3) NOT NULL,
  "programVersionId" TEXT,
  "redemptionValue" DECIMAL(18,6) NOT NULL DEFAULT 0,
  "positivePoints" BIGINT NOT NULL DEFAULT 0,
  "signedPoints" BIGINT NOT NULL DEFAULT 0,
  "liability" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "projectionVersion" INTEGER NOT NULL DEFAULT 1,
  "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "restaurant_insight_loyalty_liabilities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "restaurant_insight_loyalty_liabilities_org_date_key"
  ON "restaurant_insight_loyalty_liabilities"("organizationId", "businessDate");
CREATE INDEX "restaurant_insight_loyalty_liabilities_organizationId_idx"
  ON "restaurant_insight_loyalty_liabilities"("organizationId");
CREATE INDEX "restaurant_insight_loyalty_liabilities_programVersionId_idx"
  ON "restaurant_insight_loyalty_liabilities"("programVersionId");

ALTER TABLE "restaurant_insight_loyalty_liabilities"
  ADD CONSTRAINT "restaurant_insight_loyalty_liabilities_org_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_insight_loyalty_liabilities"
  ADD CONSTRAINT "tenant_insight_loyalty_programVersionId_fk"
  FOREIGN KEY ("organizationId", "programVersionId")
  REFERENCES "restaurant_loyalty_program_versions"("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "restaurant_insight_loyalty_liabilities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_insight_loyalty_liabilities" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_insight_loyalty_liabilities"
  USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
