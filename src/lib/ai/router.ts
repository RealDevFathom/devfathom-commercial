import 'server-only';

import { generateText, type CallSettings, type Prompt } from 'ai';
import { createAIModel } from './provider';
import { recordAIUsage } from './spend';

type RoutedAIInput = CallSettings &
  Prompt & {
    organizationId: string;
    branchId: string;
    feature: string;
  };

/**
 * Generate through the configured provider and meter the successful call.
 *
 * Metering is deliberately fail-open: once a provider has returned paid output,
 * a telemetry outage must not discard it and cause a retry to buy it again.
 */
export async function routeAI(input: RoutedAIInput) {
  const { organizationId, branchId, feature, ...settings } = input;
  const selection = createAIModel();
  const result = await generateText({
    ...settings,
    model: selection.model,
    providerOptions: selection.providerOptions,
  });

  try {
    await recordAIUsage({
      organizationId,
      branchId,
      feature,
      provider: selection.provider,
      model: selection.modelId,
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    });
  } catch {
    // Best-effort telemetry only; never throw away successfully purchased output.
  }

  return result;
}
