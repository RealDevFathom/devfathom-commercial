import { Prisma } from '@/generated/prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { providerForAnthropicBudget } from './router';
import {
  calculateAIUsageCost,
  effectiveModelPrice,
  pricedAIUsage,
  UnknownAIModelPriceError,
  type ModelPrice,
} from './spend';

describe('AI model spend', () => {
  it('uses the latest price effective at the usage timestamp', () => {
    const base: ModelPrice = {
      provider: 'anthropic',
      model: 'known',
      inputUsdPerMtok: new Prisma.Decimal(1),
      outputUsdPerMtok: new Prisma.Decimal(5),
      effectiveFrom: new Date('2026-10-23'),
    };
    const prices: ModelPrice[] = [
      base,
      { ...base, inputUsdPerMtok: new Prisma.Decimal(2), effectiveFrom: new Date('2026-11-01') },
    ];
    expect(effectiveModelPrice(prices, base.provider, base.model, new Date('2026-10-31'))).toBe(
      base
    );
    expect(
      effectiveModelPrice(prices, base.provider, base.model, new Date('2026-11-02'))
        .inputUsdPerMtok
    ).toEqual(new Prisma.Decimal(2));
  });

  it('rounds once to six decimal USD places using decimal arithmetic', () => {
    expect(
      calculateAIUsageCost(
        { inputUsdPerMtok: new Prisma.Decimal(1), outputUsdPerMtok: new Prisma.Decimal(5) },
        1,
        0
      ).toFixed(6)
    ).toBe('0.000001');
    expect(
      calculateAIUsageCost(
        { inputUsdPerMtok: new Prisma.Decimal('0.5'), outputUsdPerMtok: new Prisma.Decimal(0) },
        1,
        0
      ).toFixed(6)
    ).toBe('0.000001');
  });

  it('fails closed for an unknown model rather than using a provider-wide fallback', () => {
    expect(() =>
      pricedAIUsage([], {
        provider: 'anthropic',
        model: 'unknown',
        inputTokens: 1,
        outputTokens: 1,
        occurredAt: new Date('2026-10-24'),
      })
    ).toThrow(UnknownAIModelPriceError);
  });

  it('makes the budget decision from the persisted rounded cost', () => {
    const persisted = pricedAIUsage(
      [
        {
          provider: 'anthropic',
          model: 'deep',
          inputUsdPerMtok: new Prisma.Decimal(15),
          outputUsdPerMtok: new Prisma.Decimal(75),
          effectiveFrom: new Date('2026-10-23'),
        },
      ],
      {
        provider: 'anthropic',
        model: 'deep',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        occurredAt: new Date('2026-10-24'),
      }
    );
    expect(persisted.toFixed(6)).toBe('90.000000');
    expect(providerForAnthropicBudget(persisted, new Prisma.Decimal(80))).toBe('bedrock');
  });
});

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn(), create: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: mocks.withTenantDb }));

import { recordAIUsage } from './spend';

it('writes usage inside the attributed tenant scope', async () => {
  mocks.withTenantDb.mockImplementation(async (_organizationId, run) =>
    run({ aIUsage: { create: mocks.create } })
  );
  const usage = {
    organizationId: 'org-a',
    branchId: 'branch-a',
    feature: 'pharmacy.marketing-assistance',
    provider: 'google',
    model: 'gemini-test',
    inputTokens: 12,
    outputTokens: 7,
  };

  await recordAIUsage(usage);

  expect(mocks.withTenantDb).toHaveBeenCalledWith('org-a', expect.any(Function), {
    skipDrain: true,
  });
  expect(mocks.create).toHaveBeenCalledWith({ data: usage });
});
