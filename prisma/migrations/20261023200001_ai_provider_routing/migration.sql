CREATE TYPE "AISettingsMode" AS ENUM ('Auto', 'ForceAnthropic', 'ForceBedrock', 'Disabled');

CREATE TABLE "ai_settings" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "mode" "AISettingsMode" NOT NULL DEFAULT 'Auto',
  "monthlyAnthropicBudgetUsd" DECIMAL(12,4) NOT NULL DEFAULT 200,
  "cheapAnthropicModel" TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
  "standardAnthropicModel" TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  "deepAnthropicModel" TEXT NOT NULL DEFAULT 'claude-opus-4-6',
  "cheapBedrockModel" TEXT NOT NULL DEFAULT 'anthropic.claude-haiku-4-5-20251001-v1:0',
  "standardBedrockModel" TEXT NOT NULL DEFAULT 'anthropic.claude-sonnet-4-6',
  "deepBedrockModel" TEXT NOT NULL DEFAULT 'apac.anthropic.claude-opus-4-6-v1',
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedBy" TEXT,
  CONSTRAINT "ai_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_settings_singleton" CHECK ("id" = 'default'),
  CONSTRAINT "ai_settings_budget_nonnegative" CHECK ("monthlyAnthropicBudgetUsd" >= 0)
);

CREATE TABLE "ai_model_prices" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "inputUsdPerMTok" DECIMAL(14,6) NOT NULL,
  "outputUsdPerMTok" DECIMAL(14,6) NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_model_prices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_model_prices_nonnegative" CHECK ("inputUsdPerMTok" >= 0 AND "outputUsdPerMTok" >= 0)
);

CREATE TABLE "ai_usage" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "tier" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "feature" TEXT NOT NULL,
  "organizationId" TEXT,
  "inputTokens" INTEGER NOT NULL,
  "outputTokens" INTEGER NOT NULL,
  "costUsd" DECIMAL(18,8) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_usage_tokens_nonnegative" CHECK ("inputTokens" >= 0 AND "outputTokens" >= 0),
  CONSTRAINT "ai_usage_cost_nonnegative" CHECK ("costUsd" >= 0)
);

CREATE UNIQUE INDEX "ai_model_prices_provider_model_effectiveFrom_key" ON "ai_model_prices"("provider", "model", "effectiveFrom");
CREATE INDEX "ai_model_prices_provider_model_effectiveFrom_idx" ON "ai_model_prices"("provider", "model", "effectiveFrom" DESC);
CREATE INDEX "ai_usage_provider_createdAt_idx" ON "ai_usage"("provider", "createdAt");

INSERT INTO "ai_settings" ("id") VALUES ('default');

-- These are platform control-plane data. FORCE RLS prevents table owners from
-- accidentally bypassing the policy; only withPlatformDb installs this GUC.
ALTER TABLE "ai_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ai_settings_platform_only" ON "ai_settings"
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
ALTER TABLE "ai_model_prices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_model_prices" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ai_model_prices_platform_only" ON "ai_model_prices"
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
ALTER TABLE "ai_usage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_usage" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ai_usage_platform_only" ON "ai_usage"
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

REVOKE ALL ON "ai_settings", "ai_model_prices", "ai_usage" FROM PUBLIC;
