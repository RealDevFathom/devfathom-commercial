import { Prisma } from '@/generated/prisma/client';

/** Route only from costs already priced and persisted by the usage ledger. */
export function providerForAnthropicBudget(
  persistedMonthlyCostUsd: Prisma.Decimal,
  monthlyAnthropicBudgetUsd: Prisma.Decimal
): 'anthropic' | 'bedrock' {
  if (persistedMonthlyCostUsd.isNegative() || monthlyAnthropicBudgetUsd.isNegative()) {
    throw new Error('invalid_ai_budget');
  }
  return persistedMonthlyCostUsd.greaterThanOrEqualTo(monthlyAnthropicBudgetUsd)
    ? 'bedrock'
    : 'anthropic';
}
