import { Prisma } from '@/generated/prisma/client';
import type { RoutedAIProvider } from './model-defaults';

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
