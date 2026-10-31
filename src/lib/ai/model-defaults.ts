export type RoutedAIProvider = 'anthropic' | 'bedrock';
export type AIModelTier = 'cheap' | 'standard' | 'deep';

export const DEFAULT_AI_MODELS = {
  anthropic: {
    cheap: 'claude-haiku-4-5',
    standard: 'claude-sonnet-4-5',
    deep: 'claude-opus-4-1',
  },
  // On-demand invocation requires inference profiles. Opus 4.1 is US-only;
  // Haiku/Sonnet use global profiles at the catalog's standard prices.
  bedrock: {
    cheap: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    standard: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
    deep: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
  },
} as const satisfies Record<RoutedAIProvider, Record<AIModelTier, string>>;
