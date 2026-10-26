import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { DEFAULT_AI_MODELS, type AIModelTier, type RoutedAIProvider } from './model-defaults';
import { calculateAIUsageCost, UnknownAIModelPriceError } from './spend';
import { providerForAnthropicBudget } from './router';

export const AI_GENERATION_LIMITS = {
  maxSteps: 6,
  maxOutputTokensPerStep: 4_096,
  // All routed defaults have a 200k context window. Charging that entire
  // window on every step is intentionally conservative, including tool output.
  maxInputTokensPerStep: 200_000,
  reservationTtlMs: 2 * 60_000,
} as const;

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
  if (existing && existing.status !== 'CANCELLED')
    return { provider: existing.provider as RoutedAIProvider, model: existing.model, isReplay: true };

  const aggregate = await db.aiUsage.aggregate({
    where: {
      organizationId: input.organizationId,
      provider: 'anthropic',
      occurredAt: { gte: monthStart(occurredAt), lte: occurredAt },
      OR: [
        { status: 'COMPLETED' },
        { status: 'RESERVED', expiresAt: { gt: occurredAt } },
      ],
    },
    _sum: { costUsd: true },
  });
  const spent = aggregate._sum.costUsd ?? new Prisma.Decimal(0);
  const provider: RoutedAIProvider = providerForAnthropicBudget(spent, input.monthlyBudgetUsd);
  const model = DEFAULT_AI_MODELS[provider][input.tier];
  const price = await db.aiModelPrice.findFirst({
    where: { provider, model, effectiveFrom: { lte: occurredAt } },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!price) throw new UnknownAIModelPriceError(provider, model);
  const reservedCostUsd = calculateAIUsageCost(
    price,
    AI_GENERATION_LIMITS.maxInputTokensPerStep * AI_GENERATION_LIMITS.maxSteps,
    AI_GENERATION_LIMITS.maxOutputTokensPerStep * AI_GENERATION_LIMITS.maxSteps
  );
  const data = {
    provider,
    model,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: reservedCostUsd,
    status: 'RESERVED' as const,
    expiresAt: new Date(occurredAt.getTime() + AI_GENERATION_LIMITS.reservationTtlMs),
    occurredAt,
    completedAt: null,
  };
  if (existing) {
    await db.aiUsage.update({
      where: { organizationId_requestId: { organizationId: input.organizationId, requestId: input.requestId } },
      data,
    });
  } else {
    await db.aiUsage.create({
      data: { organizationId: input.organizationId, requestId: input.requestId, ...data },
    });
  }
  return { provider, model, isReplay: false };
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
  if (usage.status !== 'RESERVED') return usage;
  const occurredAt = input.occurredAt ?? usage.occurredAt;
  const price = await db.aiModelPrice.findFirst({
    where: { provider: usage.provider, model: usage.model, effectiveFrom: { lte: occurredAt } },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!price) throw new UnknownAIModelPriceError(usage.provider, usage.model);
  const costUsd = calculateAIUsageCost(price, input.inputTokens, input.outputTokens);
  await db.aiUsage.updateMany({
    where: { organizationId: input.organizationId, requestId: input.requestId, status: 'RESERVED' },
    data: {
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      costUsd,
      status: 'COMPLETED',
      completedAt: new Date(),
    },
  });
  return db.aiUsage.findUniqueOrThrow({
    where: { organizationId_requestId: { organizationId: input.organizationId, requestId: input.requestId } },
  });
}

/** Releases an unfinished reservation; racing terminal transitions are first-writer-wins. */
export async function cancelAIUsage(db: ScopedDb, organizationId: string, requestId: string) {
  await db.aiUsage.updateMany({
    where: { organizationId, requestId, status: 'RESERVED' },
    data: { costUsd: new Prisma.Decimal(0), status: 'CANCELLED', completedAt: new Date() },
  });
}

/**
 * Conservatively charges the full reservation when provider work started but
 * its final token usage is unavailable (for example, a downstream abort).
 */
export async function commitAIUsageReservation(
  db: ScopedDb,
  organizationId: string,
  requestId: string
) {
  const usage = await db.aiUsage.findUnique({
    where: { organizationId_requestId: { organizationId, requestId } },
  });
  if (!usage || usage.status !== 'RESERVED') return;
  const price = await db.aiModelPrice.findFirst({
    where: { provider: usage.provider, model: usage.model, effectiveFrom: { lte: usage.occurredAt } },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!price) throw new UnknownAIModelPriceError(usage.provider, usage.model);
  const costUsd = calculateAIUsageCost(
    price,
    AI_GENERATION_LIMITS.maxInputTokensPerStep * AI_GENERATION_LIMITS.maxSteps,
    AI_GENERATION_LIMITS.maxOutputTokensPerStep * AI_GENERATION_LIMITS.maxSteps
  );
  await db.aiUsage.updateMany({
    where: { organizationId, requestId, status: 'RESERVED' },
    data: { costUsd, status: 'COMPLETED', completedAt: new Date() },
  });
}
