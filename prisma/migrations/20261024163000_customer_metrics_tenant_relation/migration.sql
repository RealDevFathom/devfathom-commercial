-- G9 native-schema prerequisite inherited from the unmigrated G1 draft.
-- Materialize only the existing CustomerMetrics model; preserve its global
-- customer primary key and add the explicit defining-side composite uniqueness
-- required by Prisma's tenant-bound one-to-one relation. No customer/consent
-- backfill, existing migration rewrite, message claim or growth sender is added.
CREATE TABLE "customer_metrics" (
  "customerId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "lastPurchaseAt" TIMESTAMP(3),
  "orders90d" INTEGER NOT NULL DEFAULT 0,
  "spend90dMinor" INTEGER NOT NULL DEFAULT 0,
  "medianGapDays" INTEGER,
  "churnScore" INTEGER NOT NULL DEFAULT 0,
  "churnBand" TEXT NOT NULL DEFAULT 'low',
  "nextRefillDueAt" TIMESTAMP(3),
  "computedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "customer_metrics_pkey" PRIMARY KEY ("customerId"),
  CONSTRAINT "customer_metrics_organizationId_customerId_fkey"
    FOREIGN KEY ("organizationId", "customerId")
    REFERENCES "pharmacy_customers" ("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "customer_metrics_organizationId_customerId_key"
  ON "customer_metrics" ("organizationId", "customerId");
CREATE INDEX "customer_metrics_organizationId_churnBand_idx"
  ON "customer_metrics" ("organizationId", "churnBand");
CREATE INDEX "customer_metrics_organizationId_nextRefillDueAt_idx"
  ON "customer_metrics" ("organizationId", "nextRefillDueAt");

ALTER TABLE "customer_metrics" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_metrics" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customer_metrics"
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );
