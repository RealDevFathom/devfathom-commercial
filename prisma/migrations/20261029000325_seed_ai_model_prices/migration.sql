-- The router must have an effective price from the first request on a fresh database.
CREATE TABLE "ai_model_prices" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputUsdPerMillionTokens" DECIMAL(12,6) NOT NULL,
    "outputUsdPerMillionTokens" DECIMAL(12,6) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_model_prices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_model_prices_provider_model_effectiveFrom_key"
  ON "ai_model_prices"("provider", "model", "effectiveFrom");
CREATE INDEX "ai_model_prices_provider_model_effectiveFrom_idx"
  ON "ai_model_prices"("provider", "model", "effectiveFrom" DESC);

CREATE TABLE "ai_usage_ledger" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL CHECK ("inputTokens" >= 0),
    "outputTokens" INTEGER NOT NULL CHECK ("outputTokens" >= 0),
    "costUsd" DECIMAL(18,6) NOT NULL CHECK ("costUsd" >= 0),
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_usage_ledger_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_usage_ledger_provider_occurredAt_idx"
  ON "ai_usage_ledger"("provider", "occurredAt");

-- Public list prices in USD per million tokens. Bedrock currently has the same
-- rates, but remains separately effective-dated so either catalog can change safely.
INSERT INTO "ai_model_prices"
  ("id", "provider", "model", "inputUsdPerMillionTokens", "outputUsdPerMillionTokens", "effectiveFrom")
VALUES
  ('price_anthropic_haiku_45_2026', 'anthropic', 'claude-haiku-4-5-20251001', 1.000000, 5.000000, '2026-01-01T00:00:00.000Z'),
  ('price_anthropic_sonnet_45_2026', 'anthropic', 'claude-sonnet-4-5-20250929', 3.000000, 15.000000, '2026-01-01T00:00:00.000Z'),
  ('price_anthropic_opus_41_2026', 'anthropic', 'claude-opus-4-1-20250805', 15.000000, 75.000000, '2026-01-01T00:00:00.000Z'),
  ('price_bedrock_haiku_45_2026', 'bedrock', 'us.anthropic.claude-haiku-4-5-20251001-v1:0', 1.000000, 5.000000, '2026-01-01T00:00:00.000Z'),
  ('price_bedrock_sonnet_45_2026', 'bedrock', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', 3.000000, 15.000000, '2026-01-01T00:00:00.000Z'),
  ('price_bedrock_opus_41_2026', 'bedrock', 'us.anthropic.claude-opus-4-1-20250805-v1:0', 15.000000, 75.000000, '2026-01-01T00:00:00.000Z');
