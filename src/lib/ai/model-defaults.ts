export type RoutedAIProvider = 'anthropic' | 'bedrock';
export type AIModelTier = 'cheap' | 'standard' | 'deep';

export const DEFAULT_AI_MODELS = {
  anthropic: {
    cheap: 'claude-haiku-4-5',
    standard: 'claude-sonnet-4-5',
    deep: 'claude-opus-4-1',
  },
  bedrock: {
    cheap: 'anthropic.claude-haiku-4-5-20251001-v1:0',
    standard: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
    deep: 'anthropic.claude-opus-4-1-20250805-v1:0',
  },
} as const satisfies Record<RoutedAIProvider, Record<AIModelTier, string>>;
