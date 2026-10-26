CREATE TABLE IF NOT EXISTS "ai_model_prices" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "input_usd_per_mtok" DECIMAL(18, 6) NOT NULL,
  "output_usd_per_mtok" DECIMAL(18, 6) NOT NULL,
  "effective_from" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_model_prices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_model_prices_nonnegative_check"
    CHECK ("input_usd_per_mtok" >= 0 AND "output_usd_per_mtok" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "ai_model_prices_provider_model_effective_from_key"
  ON "ai_model_prices" ("provider", "model", "effective_from");

INSERT INTO "ai_model_prices"
  ("id", "provider", "model", "input_usd_per_mtok", "output_usd_per_mtok", "effective_from")
VALUES
  ('price_anthropic_haiku_4_5_20261023', 'anthropic', 'claude-haiku-4-5', 1, 5, '2026-10-23T00:00:00Z'),
  ('price_anthropic_sonnet_4_5_20261023', 'anthropic', 'claude-sonnet-4-5', 3, 15, '2026-10-23T00:00:00Z'),
  ('price_anthropic_opus_4_1_20261023', 'anthropic', 'claude-opus-4-1', 15, 75, '2026-10-23T00:00:00Z'),
  ('price_bedrock_haiku_4_5_20261023', 'bedrock', 'anthropic.claude-haiku-4-5-20251001-v1:0', 1, 5, '2026-10-23T00:00:00Z'),
  ('price_bedrock_sonnet_4_5_20261023', 'bedrock', 'anthropic.claude-sonnet-4-5-20250929-v1:0', 3, 15, '2026-10-23T00:00:00Z'),
  ('price_bedrock_opus_4_1_20261023', 'bedrock', 'anthropic.claude-opus-4-1-20250805-v1:0', 15, 75, '2026-10-23T00:00:00Z')
ON CONFLICT ("provider", "model", "effective_from") DO UPDATE SET
  "input_usd_per_mtok" = EXCLUDED."input_usd_per_mtok",
  "output_usd_per_mtok" = EXCLUDED."output_usd_per_mtok";

CREATE TABLE IF NOT EXISTS "ai_usages" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "request_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "input_tokens" INTEGER,
  "output_tokens" INTEGER,
  "cost_usd" DECIMAL(18, 6) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RESERVED',
  "expires_at" TIMESTAMP(3) NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "ai_usages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_usages_nonnegative_check" CHECK
    ("cost_usd" >= 0 AND ("input_tokens" IS NULL OR "input_tokens" >= 0)
      AND ("output_tokens" IS NULL OR "output_tokens" >= 0)),
  CONSTRAINT "ai_usages_status_check" CHECK ("status" IN ('RESERVED', 'COMPLETED', 'CANCELLED'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "ai_usages_organization_id_request_id_key"
  ON "ai_usages" ("organization_id", "request_id");
CREATE INDEX IF NOT EXISTS "ai_usages_organization_id_provider_occurred_at_idx"
  ON "ai_usages" ("organization_id", "provider", "occurred_at");
ALTER TABLE "ai_usages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_usages" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ai_usages_tenant_isolation" ON "ai_usages"
  USING ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK ("organization_id" = NULLIF(current_setting('app.current_organization_id', true), ''));
