ALTER TYPE "RestaurantPaymentProvider" ADD VALUE 'TERMINAL';
CREATE TYPE "RestaurantTerminalProviderMode" AS ENUM ('DISABLED', 'SIMULATION', 'WEBHOOK');
CREATE TYPE "RestaurantTerminalEventStatus" AS ENUM ('INITIATED', 'APPROVED', 'DECLINED', 'VOIDED');

CREATE TABLE "restaurant_terminal_provider_configs" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "externalTerminalId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "mode" "RestaurantTerminalProviderMode" NOT NULL DEFAULT 'DISABLED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "restaurant_terminal_provider_configs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_terminal_provider_configs_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE,
  CONSTRAINT "restaurant_terminal_provider_configs_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "restaurant_registered_devices"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "restaurant_terminal_provider_configs_organizationId_source_externalTerminalId_key" ON "restaurant_terminal_provider_configs"("organizationId", "source", "externalTerminalId");
CREATE INDEX "restaurant_terminal_provider_configs_organizationId_idx" ON "restaurant_terminal_provider_configs"("organizationId");
CREATE INDEX "restaurant_terminal_provider_configs_branchId_idx" ON "restaurant_terminal_provider_configs"("branchId");

CREATE TABLE "restaurant_terminal_reconciliations" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "configId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "externalEventId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "eventStatus" "RestaurantTerminalEventStatus" NOT NULL,
  "externalReference" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "tipAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "billId" TEXT,
  "paymentId" TEXT,
  "tenderId" TEXT,
  "outcome" TEXT NOT NULL,
  "failureReason" TEXT,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "restaurant_terminal_reconciliations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_terminal_reconciliations_configId_fkey" FOREIGN KEY ("configId") REFERENCES "restaurant_terminal_provider_configs"("id") ON DELETE RESTRICT,
  CONSTRAINT "restaurant_terminal_reconciliations_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE RESTRICT,
  CONSTRAINT "restaurant_terminal_reconciliations_billId_fkey" FOREIGN KEY ("billId") REFERENCES "restaurant_bills"("id") ON DELETE SET NULL,
  CONSTRAINT "restaurant_terminal_reconciliations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "restaurant_payments"("id") ON DELETE SET NULL,
  CONSTRAINT "restaurant_terminal_reconciliations_tenderId_fkey" FOREIGN KEY ("tenderId") REFERENCES "restaurant_tenders"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "restaurant_terminal_reconciliations_organizationId_source_externalEventId_key" ON "restaurant_terminal_reconciliations"("organizationId", "source", "externalEventId");
CREATE INDEX "restaurant_terminal_reconciliations_organizationId_idx" ON "restaurant_terminal_reconciliations"("organizationId");
CREATE INDEX "restaurant_terminal_reconciliations_branchId_processedAt_idx" ON "restaurant_terminal_reconciliations"("branchId", "processedAt");

ALTER TABLE "restaurant_terminal_provider_configs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_terminal_provider_configs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_terminal_provider_configs" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_terminal_reconciliations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_terminal_reconciliations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation_select" ON "restaurant_terminal_reconciliations" FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "tenant_isolation_insert" ON "restaurant_terminal_reconciliations" FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
