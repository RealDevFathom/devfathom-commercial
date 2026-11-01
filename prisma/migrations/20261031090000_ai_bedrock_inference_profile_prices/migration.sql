-- Inference profile IDs are the invocable models used by the budget router.
-- Keep the original base-ID prices for historical ledger entries.
-- Global Haiku/Sonnet profiles have no regional premium; Opus 4.1 only
-- supports US cross-region inference at its existing $15/$75 rates.
-- https://docs.anthropic.com/en/api/claude-on-amazon-bedrock
INSERT INTO "ai_model_prices"
  ("id", "provider", "model", "input_usd_per_mtok", "output_usd_per_mtok", "effective_from")
VALUES
  ('price_bedrock_global_haiku_4_5_20261023', 'bedrock', 'global.anthropic.claude-haiku-4-5-20251001-v1:0', 1, 5, '2026-10-23T00:00:00Z'),
  ('price_bedrock_global_sonnet_4_5_20261023', 'bedrock', 'global.anthropic.claude-sonnet-4-5-20250929-v1:0', 3, 15, '2026-10-23T00:00:00Z'),
  ('price_bedrock_us_opus_4_1_20261023', 'bedrock', 'us.anthropic.claude-opus-4-1-20250805-v1:0', 15, 75, '2026-10-23T00:00:00Z')
ON CONFLICT ("provider", "model", "effective_from") DO UPDATE SET
  "input_usd_per_mtok" = EXCLUDED."input_usd_per_mtok",
  "output_usd_per_mtok" = EXCLUDED."output_usd_per_mtok";
