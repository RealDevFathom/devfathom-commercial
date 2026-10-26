import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { DEFAULT_AI_MODELS, type AIModelTier, type RoutedAIProvider } from './model-defaults';
import { calculateAIUsageCost, UnknownAIModelPriceError } from './spend';

const RESERVATION_USD = new Prisma.Decimal('0.100000');

function monthStart(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

/**
 * Atomically chooses a provider and reserves budget. The tenant advisory lock
 * makes the read/decision/write indivisible across application instances.
 */
export async function reserveAIUsage(
  db: ScopedDb,
  input: {
    organizationId: string;
    requestId: string;
    tier: AIModelTier;
    monthlyBudgetUsd: Prisma.Decimal;
    occurredAt?: Date;
  }
) {
  if (input.monthlyBudgetUsd.isNegative()) throw new Error('invalid_ai_budget');
  const occurredAt = input.occurredAt ?? new Date();
  await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai-budget:${input.organizationId}`}))`;

  const existing = await db.aiUsage.findUnique({
    where: { organizationId_requestId: { organizationId: input.organizationId, requestId: input.requestId } },
  });
  if (existing) return { provider: existing.provider as RoutedAIProvider, model: existing.model };

  const aggregate = await db.aiUsage.aggregate({
    where: {
      organizationId: input.organizationId,
      provider: 'anthropic',
      occurredAt: { gte: monthStart(occurredAt), lte: occurredAt },
    },
    _sum: { costUsd: true },
  });
  const spent = aggregate._sum.costUsd ?? new Prisma.Decimal(0);
  const provider: RoutedAIProvider = spent.plus(RESERVATION_USD).greaterThan(input.monthlyBudgetUsd)
    ? 'bedrock'
    : 'anthropic';
  const model = DEFAULT_AI_MODELS[provider][input.tier];
  await db.aiUsage.create({
    data: {
      organizationId: input.organizationId,
      requestId: input.requestId,
      provider,
      model,
      costUsd: RESERVATION_USD,
      occurredAt,
    },
  });
  return { provider, model };
}

/** Completes a reservation exactly once and prices it from the database catalog. */
export async function recordAIUsage(
  db: ScopedDb,
  input: { organizationId: string; requestId: string; inputTokens: number; outputTokens: number; occurredAt?: Date }
) {
  const usage = await db.aiUsage.findUnique({
    where: { organizationId_requestId: { organizationId: input.organizationId, requestId: input.requestId } },
  });
  if (!usage) throw new Error('ai_usage_reservation_missing');
  if (usage.completedAt) return usage;
  const occurredAt = input.occurredAt ?? usage.occurredAt;
  const price = await db.aiModelPrice.findFirst({
    where: { provider: usage.provider, model: usage.model, effectiveFrom: { lte: occurredAt } },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!price) throw new UnknownAIModelPriceError(usage.provider, usage.model);
  const costUsd = calculateAIUsageCost(price, input.inputTokens, input.outputTokens);
  return db.aiUsage.update({
    where: { organizationId_requestId: { organizationId: input.organizationId, requestId: input.requestId } },
    data: { inputTokens: input.inputTokens, outputTokens: input.outputTokens, costUsd, completedAt: new Date() },
  });
}
