import 'server-only';

import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
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

/**
 * Select the newest catalog price that was already effective when the usage
 * occurred. Fails closed: an unpriced model is never charged a fallback rate.
 */
export async function findEffectiveModelPrice(
  db: Pick<ScopedDb, 'aiModelPrice'>,
  provider: string,
  model: string,
  at: Date
) {
  const price = await db.aiModelPrice.findFirst({
    where: { provider, model, effectiveFrom: { lte: at } },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!price) throw new UnknownAIModelPriceError(provider, model);
  return price;
}

/** Costs are persisted in USD to six decimal places; Decimal avoids float drift. */
export function calculateAIUsageCost(
  price: Pick<ModelPrice, 'inputUsdPerMtok' | 'outputUsdPerMtok'>,
  inputTokens: number,
  outputTokens: number
): Prisma.Decimal {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0)
    throw new Error('invalid_input_tokens');
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 0)
    throw new Error('invalid_output_tokens');

  return price.inputUsdPerMtok
    .mul(inputTokens)
    .plus(price.outputUsdPerMtok.mul(outputTokens))
    .div(1_000_000)
    .toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);
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
