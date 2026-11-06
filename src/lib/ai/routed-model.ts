import type { LanguageModelV3 } from '@ai-sdk/provider';

import type { AITier } from './tiers';
import type { TurnBudget } from './turn-budget';

export type RoutedCallContext = {
  /** The requested tier; the router resolves the tier actually used (workload.ts). */
  tier: AITier;
  feature: string;
  organizationId: string | null;
  /** The owner turn's shared limits: every provider attempt, retries included, spends one call. */
  turn?: TurnBudget;
  /** Injected in tests; production reads process.env at call time. */
  env?: Record<string, string | undefined>;
};

/**
 * A language model that is really the routed provider chain. Construction is
 * synchronous and cheap, so the existing `createAIModel()` call sites keep their
 * shape; settings, secrets, spend caps and the fallback order are resolved when a
 * call is made. The router is loaded lazily so importing the provider module never
 * pulls in database access.
 */
export function createRoutedLanguageModel(context: RoutedCallContext): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'devfathom.routed',
    modelId: `auto:${context.tier}`,
    // No URL is passed through as-is: the SDK inlines remote files, so every
    // provider in the chain receives the same request.
    supportedUrls: {},
    doGenerate: async (options) => (await import('./router')).routedGenerate(context, options),
    doStream: async (options) => (await import('./router')).routedStream(context, options),
  };
}
