import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), model: vi.fn(), record: vi.fn() }));
vi.mock('ai', () => ({ generateText: mocks.generate }));
vi.mock('./provider', () => ({ createAIModel: mocks.model }));
vi.mock('./spend', () => ({ recordAIUsage: mocks.record }));

import { routeAI, routeAIProvider } from './router';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.model.mockReturnValue({
    model: 'provider-model',
    provider: 'google',
    modelId: 'gemini-test',
  });
  mocks.generate.mockResolvedValue({
    text: 'paid output',
    usage: { inputTokens: 12, outputTokens: 7 },
  });
});

it('records the server-derived organization and branch for a successful generation', async () => {
  await routeAI({
    organizationId: 'org-a',
    branchId: 'branch-a',
    feature: 'pharmacy.marketing-assistance',
    prompt: 'safe prompt',
  });

  expect(mocks.record).toHaveBeenCalledWith({
    organizationId: 'org-a',
    branchId: 'branch-a',
    feature: 'pharmacy.marketing-assistance',
    provider: 'google',
    model: 'gemini-test',
    inputTokens: 12,
    outputTokens: 7,
  });
});

it('returns paid output when usage telemetry fails instead of causing a paid retry', async () => {
  mocks.record.mockRejectedValue(new Error('usage database unavailable'));

  await expect(
    routeAI({
      organizationId: 'org-a',
      branchId: 'branch-a',
      feature: 'pharmacy.marketing-assistance',
      prompt: 'safe prompt',
    })
  ).resolves.toMatchObject({ text: 'paid output' });
  expect(mocks.generate).toHaveBeenCalledTimes(1);
});

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
