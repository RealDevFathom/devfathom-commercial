CREATE TABLE "growth_settings" (
  "organizationId" TEXT PRIMARY KEY REFERENCES "organizations"("id") ON DELETE CASCADE,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "nightlyMetricsEnabled" BOOLEAN NOT NULL DEFAULT false,
  "lookbackDays" INTEGER NOT NULL DEFAULT 90 CHECK ("lookbackDays" BETWEEN 7 AND 365),
  "minimumAudienceSize" INTEGER NOT NULL DEFAULT 10 CHECK ("minimumAudienceSize" BETWEEN 10 AND 10000),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "growth_customer_metrics" (
  "organizationId" TEXT NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "vertical" TEXT NOT NULL CHECK ("vertical" IN ('PHARMACY', 'RESTAURANT')),
  "customerId" TEXT NOT NULL,
  "metricDate" DATE NOT NULL,
  "lastActivityAt" TIMESTAMPTZ NOT NULL,
  "orderCount" INTEGER NOT NULL CHECK ("orderCount" > 0),
  "grossAmount" NUMERIC(14,2) NOT NULL CHECK ("grossAmount" >= 0),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("organizationId", "vertical", "customerId", "metricDate")
);
CREATE INDEX "growth_customer_metrics_organizationId_metricDate_idx"
  ON "growth_customer_metrics" ("organizationId", "metricDate");

-- FORCE makes these policies apply to the application table owner as well.
-- There is deliberately no platform bypass: platform code must narrow into a
-- tenant transaction before it can read or mutate either table.
ALTER TABLE "growth_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "growth_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "growth_settings_tenant_only" ON "growth_settings"
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "growth_customer_metrics" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "growth_customer_metrics" FORCE ROW LEVEL SECURITY;
CREATE POLICY "growth_customer_metrics_tenant_only" ON "growth_customer_metrics"
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
