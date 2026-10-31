import 'server-only';

import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { Prisma } from '@/generated/prisma/client';
import type { RoutedAIProvider } from './model-defaults';

export type ModelPrice = {
  provider: RoutedAIProvider;
  model: string;
  inputUsdPerMtok: Prisma.Decimal;
  outputUsdPerMtok: Prisma.Decimal;
  effectiveFrom: Date;
};

export class UnknownAIModelPriceError extends Error {
  constructor(provider: string, model: string) {
    super(`No effective AI model price for ${provider}/${model}`);
    this.name = 'UnknownAIModelPriceError';
  }
}

/** Select the newest price that was already effective when the usage occurred. */
export function effectiveModelPrice(
  prices: readonly ModelPrice[],
  provider: RoutedAIProvider,
  model: string,
  occurredAt: Date
): ModelPrice {
  const price = prices
    .filter(
      (candidate) =>
        candidate.provider === provider &&
        candidate.model === model &&
        candidate.effectiveFrom.getTime() <= occurredAt.getTime()
    )
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];

  if (!price) throw new UnknownAIModelPriceError(provider, model);
  return price;
}

/** Costs are persisted in USD to six decimal places; Decimal avoids float drift. */
export function calculateAIUsageCost(
  price: Pick<ModelPrice, 'inputUsdPerMtok' | 'outputUsdPerMtok'>,
  inputTokens: number,
  outputTokens: number
): Prisma.Decimal {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) throw new Error('invalid_input_tokens');
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 0)
    throw new Error('invalid_output_tokens');

  return price.inputUsdPerMtok
    .mul(inputTokens)
    .plus(price.outputUsdPerMtok.mul(outputTokens))
    .div(1_000_000)
    .toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);
}

export function pricedAIUsage(
  prices: readonly ModelPrice[],
  usage: {
    provider: RoutedAIProvider;
    model: string;
    inputTokens: number;
    outputTokens: number;
    occurredAt: Date;
  }
): Prisma.Decimal {
  return calculateAIUsageCost(
    effectiveModelPrice(prices, usage.provider, usage.model, usage.occurredAt),
    usage.inputTokens,
    usage.outputTokens
  );
}

export type AIUsageRecord = {
  organizationId: string;
  branchId: string;
  feature: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

/** Persist tenant-attributed metering. Callers decide whether metering is fail-open. */
export async function recordAIUsage(usage: AIUsageRecord): Promise<void> {
  await withTenantDb(
    usage.organizationId,
    async (db) => {
      await db.aIUsage.create({ data: usage });
    },
    { skipDrain: true }
  );
}
