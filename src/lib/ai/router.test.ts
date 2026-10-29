import { Prisma } from '@/generated/prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { routeAIProvider } from './router';

describe('AI provider budget routing', () => {
  it.each([
    ['9.999999', 'anthropic'],
    ['10.000000', 'bedrock'],
    ['75', 'bedrock'],
  ] as const)('routes using persisted monthly cost %s', async (costUsd, expected) => {
    const aggregate = vi.fn().mockResolvedValue({ _sum: { costUsd: new Prisma.Decimal(costUsd) } });
    await expect(
      routeAIProvider({
        ledger: { aggregate },
        monthlyAnthropicBudgetUsd: '10',
        at: new Date('2026-10-29T12:00:00Z'),
      })
    ).resolves.toBe(expected);
    expect(aggregate).toHaveBeenCalledWith({
      where: {
        provider: 'anthropic',
        occurredAt: { gte: new Date('2026-10-01T00:00:00Z'), lt: new Date('2026-11-01T00:00:00Z') },
      },
      _sum: { costUsd: true },
    });
  });
});
