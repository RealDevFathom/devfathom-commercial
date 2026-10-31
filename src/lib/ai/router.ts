import 'server-only';

import { generateText, type CallSettings, type Prompt } from 'ai';
import { Prisma } from '@/generated/prisma/client';
import { createAIModel } from './provider';
import { recordAIUsage } from './spend';
import type { RoutedAIProvider } from './model-defaults';

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
  const { prepareAIModel } = await import('./metered-model');
  const selection = await prepareAIModel(createAIModel());
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

export type AnthropicSpendLedger = {
  aggregate(args: {
    where: { provider: 'anthropic'; occurredAt: { gte: Date; lt: Date } };
    _sum: { costUsd: true };
  }): Promise<{ _sum: { costUsd: Prisma.Decimal | null } }>;
};

export async function routeAIProvider(input: {
  ledger: AnthropicSpendLedger;
  monthlyAnthropicBudgetUsd: Prisma.Decimal | string;
  at?: Date;
}): Promise<RoutedAIProvider> {
  const at = input.at ?? new Date();
  const monthStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const nextMonth = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  const persisted = await input.ledger.aggregate({
    where: { provider: 'anthropic', occurredAt: { gte: monthStart, lt: nextMonth } },
    _sum: { costUsd: true },
  });
  const spend = persisted._sum.costUsd ?? new Prisma.Decimal(0);
  return spend.greaterThanOrEqualTo(input.monthlyAnthropicBudgetUsd) ? 'bedrock' : 'anthropic';
}
