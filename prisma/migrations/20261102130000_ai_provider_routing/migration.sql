-- AI provider routing, spend caps and SuperAdmin settings (DEV-576).
--
-- Supersedes the unmerged migrations 20261023200001_ai_provider_routing and
-- 20261023200004_ai_usage_budget_alerts from feat/ai-provider-3/-4. Those never
-- reached develop, so they are reshaped here instead of altered:
--   * develop already owns "ai_usage" (tenant/branch attribution, 20261029000277),
--     so the platform spend ledger is its own table, "ai_provider_usage";
--   * OpenAI joins Anthropic and Bedrock; each provider gets a monthly spend cap
--     instead of the single Anthropic budget;
--   * every setting is an optional override (no seeded row), so the environment
--     defaults apply until a SUPER_ADMIN saves the settings;
--   * budget alert claims are per provider.
-- Azure is not a routed provider and does not appear here.

CREATE TYPE "AISettingsMode" AS ENUM ('Auto', 'ForceAnthropic', 'ForceOpenAI', 'ForceBedrock', 'Disabled');

CREATE TABLE "ai_settings" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "mode" "AISettingsMode" NOT NULL DEFAULT 'Auto',
  "providerOrder" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "fallbackEnabled" BOOLEAN NOT NULL DEFAULT true,
  "anthropicMonthlyCapUsd" DECIMAL(12,4),
  "openaiMonthlyCapUsd" DECIMAL(12,4),
  "bedrockMonthlyCapUsd" DECIMAL(12,4),
  "cheapAnthropicModel" TEXT,
  "standardAnthropicModel" TEXT,
  "deepAnthropicModel" TEXT,
  "cheapOpenaiModel" TEXT,
  "standardOpenaiModel" TEXT,
  "deepOpenaiModel" TEXT,
  "cheapBedrockModel" TEXT,
  "standardBedrockModel" TEXT,
  "deepBedrockModel" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedBy" TEXT,
  CONSTRAINT "ai_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_settings_singleton" CHECK ("id" = 'default'),
  CONSTRAINT "ai_settings_provider_order" CHECK (
    cardinality("providerOrder") <= 3
    AND "providerOrder" <@ ARRAY['anthropic', 'openai', 'bedrock']::TEXT[]
  ),
  CONSTRAINT "ai_settings_caps_nonnegative" CHECK (
    COALESCE("anthropicMonthlyCapUsd", 0) >= 0
    AND COALESCE("openaiMonthlyCapUsd", 0) >= 0
    AND COALESCE("bedrockMonthlyCapUsd", 0) >= 0
  )
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
CREATE UNIQUE INDEX "ai_model_prices_provider_model_effectiveFrom_key" ON "ai_model_prices"("provider", "model", "effectiveFrom");
CREATE INDEX "ai_model_prices_provider_model_effectiveFrom_idx" ON "ai_model_prices"("provider", "model", "effectiveFrom" DESC);

CREATE TABLE "ai_provider_usage" (
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
  CONSTRAINT "ai_provider_usage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_provider_usage_provider" CHECK ("provider" IN ('anthropic', 'openai', 'bedrock')),
  CONSTRAINT "ai_provider_usage_tokens_nonnegative" CHECK ("inputTokens" >= 0 AND "outputTokens" >= 0),
  CONSTRAINT "ai_provider_usage_cost_nonnegative" CHECK ("costUsd" >= 0)
);
CREATE INDEX "ai_provider_usage_provider_createdAt_idx" ON "ai_provider_usage"("provider", "createdAt");

-- Concurrency-safe cap alerts: one claim per provider and Asia/Karachi month.
CREATE TABLE "ai_budget_alert_months" (
  "provider" TEXT NOT NULL,
  "month" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_budget_alert_months_pkey" PRIMARY KEY ("provider", "month"),
  CONSTRAINT "ai_budget_alert_provider" CHECK ("provider" IN ('anthropic', 'openai', 'bedrock')),
  CONSTRAINT "ai_budget_alert_month_format" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);

CREATE TABLE "platform_notifications" (
  "id" TEXT NOT NULL,
  "platformUserId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "isRead" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_notifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_notifications_user_fkey" FOREIGN KEY ("platformUserId") REFERENCES "platform_users"("id") ON DELETE CASCADE
);
CREATE INDEX "platform_notifications_user_unread_idx" ON "platform_notifications"("platformUserId", "isRead", "createdAt" DESC);

-- Platform control-plane data. FORCE RLS stops table owners bypassing the policy;
-- only withPlatformDb sets the platform-admin GUC.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_settings', 'ai_model_prices', 'ai_provider_usage', 'ai_budget_alert_months', 'platform_notifications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (current_setting(''app.is_platform_admin'', true) = ''true'') WITH CHECK (current_setting(''app.is_platform_admin'', true) = ''true'')',
      t || '_platform_only', t
    );
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
  END LOOP;
END $$;
