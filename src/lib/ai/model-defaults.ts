import type { AITier } from './tiers';

export type TieredAIProviderName = 'anthropic' | 'bedrock';
export type AIModelOverrides = Partial<Record<AITier, string>>;

export const DEFAULT_MODELS = {
  anthropic: {
    cheap: 'claude-haiku-4-5-20251001',
    standard: 'claude-sonnet-4-6',
    deep: 'claude-opus-4-6',
  },
  bedrock: {
    cheap: 'anthropic.claude-haiku-4-5-20251001-v1:0',
    standard: 'anthropic.claude-sonnet-4-6',
    deep: 'apac.anthropic.claude-opus-4-6-v1',
  },
} as const satisfies Record<TieredAIProviderName, Record<AITier, string>>;

export function getDefaultModelId(
  provider: TieredAIProviderName,
  tier: AITier,
  overrides?: AIModelOverrides
): string {
  return overrides?.[tier]?.trim() || DEFAULT_MODELS[provider][tier];
}
