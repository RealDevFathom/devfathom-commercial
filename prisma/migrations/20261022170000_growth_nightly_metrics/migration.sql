-- Recovered from archive/rescue/WHA-82 for #460. Settings are exact-branch and
-- conflicting rules fail closed: the worker treats any DENY as authoritative.
ALTER TYPE "PlatformJobType" ADD VALUE 'growth.metrics.nightly.v1';

CREATE TABLE growth_settings (
  id TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  vertical TEXT NOT NULL CHECK (vertical IN ('PHARMACY', 'RESTAURANT')),
  effect TEXT NOT NULL CHECK (effect IN ('ALLOW', 'DENY')),
  "nightlyMetricsEnabled" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("organizationId", "branchId", vertical, id)
);
CREATE INDEX growth_settings_scope
  ON growth_settings("organizationId", "branchId", vertical);

CREATE TABLE growth_metric_snapshots (
  id TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  vertical TEXT NOT NULL CHECK (vertical IN ('PHARMACY', 'RESTAURANT')),
  "metricDate" DATE NOT NULL,
  metrics JSONB NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("organizationId", "branchId", vertical, "metricDate")
);
CREATE INDEX growth_metric_snapshots_scope
  ON growth_metric_snapshots("organizationId", "branchId", "metricDate");

ALTER TABLE growth_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE growth_metric_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_metric_snapshots FORCE ROW LEVEL SECURITY;

-- No branch-less widening and no platform bypass. The platform worker writes
-- through its dedicated role, while tenant sessions must match both keys.
CREATE POLICY growth_settings_scope_policy ON growth_settings
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
    AND "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
    AND "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''));
CREATE POLICY growth_metric_snapshots_scope_policy ON growth_metric_snapshots
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
    AND "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
    AND "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''));
