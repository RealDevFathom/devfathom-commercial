import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { DEFAULT_AI_MODELS, type RoutedAIProvider } from './model-defaults';

export type AIUsageRecord = {
  organizationId: string;
  branchId: string;
  feature: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

/** Preserve both tenant-attributed metering and the priced-ledger API. */
export function recordAIUsage(usage: AIUsageRecord): Promise<void>;
export function recordAIUsage(usage: PricedAIUsageRecord): Promise<Prisma.Decimal>;
export async function recordAIUsage(
  usage: AIUsageRecord | PricedAIUsageRecord
): Promise<void | Prisma.Decimal> {
  if ('prices' in usage) return recordPricedAIUsage(usage);
  const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
  await withTenantDb(
    usage.organizationId,
    async (db) => {
      await db.aIUsage.create({ data: usage });
    },
    { skipDrain: true }
  );
}
export type ModelPrice = {
  provider: string;
  model: string;
  inputUsdPerMillionTokens: Prisma.Decimal | string;
  outputUsdPerMillionTokens: Prisma.Decimal | string;
  effectiveFrom: Date;
};

export type UsagePriceCatalog = {
  findFirst(args: {
    where: { provider: string; model: string; effectiveFrom: { lte: Date } };
    orderBy: { effectiveFrom: 'desc' };
  }): Promise<ModelPrice | null>;
};

export type UsageLedger = {
  create(args: {
    data: {
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: Prisma.Decimal;
      occurredAt: Date;
    };
  }): Promise<unknown>;
};

export class UnknownAIModelPriceError extends Error {
  constructor(provider: string, model: string) {
    super(`No effective AI model price for ${provider}/${model}.`);
    this.name = 'UnknownAIModelPriceError';
  }
}

const knownDefaults = new Set(
  Object.entries(DEFAULT_AI_MODELS).flatMap(([provider, models]) =>
    Object.values(models).map((model) => `${provider}\0${model}`)
  )
);

export function isDefaultAIModel(provider: string, model: string): provider is RoutedAIProvider {
  return knownDefaults.has(`${provider}\0${model}`);
}

/** Calculate ledger money exactly and round once, to six decimal USD places. */
export function calculateAIUsageCost(
  price: Pick<ModelPrice, 'inputUsdPerMillionTokens' | 'outputUsdPerMillionTokens'>,
  inputTokens: number,
  outputTokens: number
): Prisma.Decimal {
  if (
    ![inputTokens, outputTokens].every(Number.isSafeInteger) ||
    inputTokens < 0 ||
    outputTokens < 0
  )
    throw new RangeError('AI token counts must be non-negative safe integers.');

  return new Prisma.Decimal(price.inputUsdPerMillionTokens)
    .mul(inputTokens)
    .plus(new Prisma.Decimal(price.outputUsdPerMillionTokens).mul(outputTokens))
    .div(1_000_000)
    .toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);
}

export type PricedAIUsageRecord = {
  prices: UsagePriceCatalog;
  ledger: UsageLedger;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  occurredAt?: Date;
};

export async function recordPricedAIUsage(input: PricedAIUsageRecord): Promise<Prisma.Decimal> {
  const occurredAt = input.occurredAt ?? new Date();
  const price = await input.prices.findFirst({
    where: { provider: input.provider, model: input.model, effectiveFrom: { lte: occurredAt } },
    orderBy: { effectiveFrom: 'desc' },
  });
  // Never silently apply another model's price. This also protects newly configured models.
  if (!price) throw new UnknownAIModelPriceError(input.provider, input.model);

  const costUsd = calculateAIUsageCost(price, input.inputTokens, input.outputTokens);
  await input.ledger.create({
    data: {
      provider: input.provider,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      costUsd,
      occurredAt,
    },
  });
  return costUsd;
}
