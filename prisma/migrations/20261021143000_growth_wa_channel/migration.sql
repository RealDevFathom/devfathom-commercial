-- WhatsApp channel tables. Named growth_wa_* so they do not collide with a later G1
-- growth settings, customer, or message-log schema.
CREATE TABLE "growth_wa_settings" (
  "organizationId" TEXT PRIMARY KEY REFERENCES "organizations"("id"),
  "monthlyBudgetMinor" INTEGER NOT NULL DEFAULT 0,
  "autoApproveUnderMinor" INTEGER NOT NULL DEFAULT 0,
  "quietHoursStart" INTEGER NOT NULL DEFAULT 21,
  "quietHoursEnd" INTEGER NOT NULL DEFAULT 9,
  "maxMsgsPerDay" INTEGER NOT NULL DEFAULT 200,
  "minSecondsBetweenMsgs" INTEGER NOT NULL DEFAULT 4,
  "waInstanceName" TEXT,
  "waApiUrl" TEXT,
  "waApiKeyEnc" TEXT,
  "waWebhookSecretHash" TEXT,
  "waWebhookSecretEnc" TEXT,
  "churnThreshold" INTEGER NOT NULL DEFAULT 60,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "growth_wa_settings_waWebhookSecretHash_key" ON "growth_wa_settings" ("waWebhookSecretHash");

CREATE TABLE "growth_wa_customers" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true) REFERENCES "organizations"("id"),
  "displayName" TEXT,
  "whatsappE164" TEXT,
  "whatsappOptIn" BOOLEAN NOT NULL DEFAULT false,
  "whatsappOptInAt" TIMESTAMP(3),
  "whatsappOptOutAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "whatsappE164")
);
CREATE INDEX "growth_wa_customers_organizationId_idx" ON "growth_wa_customers" ("organizationId");

CREATE TABLE "growth_wa_messages" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true) REFERENCES "organizations"("id"),
  "customerId" TEXT,
  "direction" TEXT NOT NULL,
  "waMessageId" TEXT,
  "body" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "campaignId" TEXT,
  "recipientId" TEXT,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "waMessageId")
);
CREATE INDEX "growth_wa_messages_organizationId_direction_status_idx" ON "growth_wa_messages" ("organizationId", "direction", "status");

CREATE TABLE "growth_wa_templates" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true) REFERENCES "organizations"("id"),
  "key" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "key", "language")
);
CREATE INDEX "growth_wa_templates_organizationId_idx" ON "growth_wa_templates" ("organizationId");

ALTER TABLE "growth_wa_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "growth_wa_settings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "growth_wa_customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "growth_wa_customers" FORCE ROW LEVEL SECURITY;
ALTER TABLE "growth_wa_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "growth_wa_messages" FORCE ROW LEVEL SECURITY;
ALTER TABLE "growth_wa_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "growth_wa_templates" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "growth_wa_settings" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY tenant_isolation ON "growth_wa_customers" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY tenant_isolation ON "growth_wa_messages" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY tenant_isolation ON "growth_wa_templates" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
