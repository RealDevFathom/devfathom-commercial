export type RoutedAIProvider = 'anthropic' | 'bedrock';
export type AIModelClass = 'cheap' | 'standard' | 'deep';

export const DEFAULT_AI_MODELS = {
  anthropic: {
    cheap: 'claude-haiku-4-5-20251001',
    standard: 'claude-sonnet-4-5-20250929',
    deep: 'claude-opus-4-1-20250805',
  },
  bedrock: {
    cheap: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    standard: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    deep: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
  },
} as const satisfies Record<RoutedAIProvider, Record<AIModelClass, string>>;

export function defaultAIModel(provider: RoutedAIProvider, modelClass: AIModelClass): string {
  return DEFAULT_AI_MODELS[provider][modelClass];
}
