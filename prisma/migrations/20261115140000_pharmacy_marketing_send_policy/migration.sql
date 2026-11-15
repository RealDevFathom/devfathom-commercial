-- DEV-24 — organization-wide marketing frequency caps, quiet hours and
-- quality auto-pause. Defaults are configurable values, not hardcoded facts.
BEGIN;

CREATE TABLE IF NOT EXISTS "pharmacy_marketing_send_policies" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "weeklyMax" INTEGER NOT NULL DEFAULT 1,
  "monthlyMax" INTEGER NOT NULL DEFAULT 2,
  "quietStartHour" INTEGER NOT NULL DEFAULT 22,
  "quietEndHour" INTEGER NOT NULL DEFAULT 9,
  "blockRatePauseBps" INTEGER NOT NULL DEFAULT 200,
  "blockRateMinSample" INTEGER NOT NULL DEFAULT 50,
  "pausedAt" TIMESTAMP(3),
  "pauseReason" TEXT,
  "pauseEvidence" JSONB,
  "resumedAt" TIMESTAMP(3),
  "resumedByUserId" TEXT,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_marketing_send_policies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_marketing_send_policies_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "pharmacy_marketing_send_policies_caps_check" CHECK ("weeklyMax" BETWEEN 1 AND 7 AND "monthlyMax" BETWEEN 1 AND 31 AND "weeklyMax" <= "monthlyMax"),
  CONSTRAINT "pharmacy_marketing_send_policies_quiet_check" CHECK ("quietStartHour" BETWEEN 0 AND 23 AND "quietEndHour" BETWEEN 0 AND 23),
  CONSTRAINT "pharmacy_marketing_send_policies_block_rate_check" CHECK ("blockRatePauseBps" BETWEEN 1 AND 10000 AND "blockRateMinSample" >= 1),
  CONSTRAINT "pharmacy_marketing_send_policies_pause_check" CHECK ("pausedAt" IS NULL OR "pauseReason" IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_marketing_send_policies_organizationId_key" ON "pharmacy_marketing_send_policies"("organizationId");

ALTER TABLE "pharmacy_marketing_send_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_marketing_send_policies" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "pharmacy_marketing_send_policies";
CREATE POLICY tenant_isolation ON "pharmacy_marketing_send_policies"
  USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

COMMIT;
