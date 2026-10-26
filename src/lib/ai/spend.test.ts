import { Prisma } from '@/generated/prisma/client';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AI_MODELS } from './model-defaults';
import { providerForAnthropicBudget } from './router';
import {
  calculateAIUsageCost,
  effectiveModelPrice,
  pricedAIUsage,
  SEEDED_MODEL_PRICES,
  UnknownAIModelPriceError,
  type ModelPrice,
} from './spend';

describe('AI model spend', () => {
  it('prices every default provider/model pair', () => {
    for (const [provider, tiers] of Object.entries(DEFAULT_AI_MODELS)) {
      for (const model of Object.values(tiers)) {
        expect(() =>
          effectiveModelPrice(
            SEEDED_MODEL_PRICES,
            provider as 'anthropic' | 'bedrock',
            model,
            new Date('2026-10-24T00:00:00Z')
          )
        ).not.toThrow();
      }
    }
  });

  it('uses the latest price effective at the usage timestamp', () => {
    const base = SEEDED_MODEL_PRICES[0]!;
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
      pricedAIUsage(SEEDED_MODEL_PRICES, {
        provider: 'anthropic',
        model: 'unknown',
        inputTokens: 1,
        outputTokens: 1,
        occurredAt: new Date('2026-10-24'),
      })
    ).toThrow(UnknownAIModelPriceError);
  });

  it('makes the budget decision from the persisted rounded cost', () => {
    const persisted = pricedAIUsage(SEEDED_MODEL_PRICES, {
      provider: 'anthropic',
      model: DEFAULT_AI_MODELS.anthropic.deep,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      occurredAt: new Date('2026-10-24'),
    });
    expect(persisted.toFixed(6)).toBe('90.000000');
    expect(providerForAnthropicBudget(persisted, new Prisma.Decimal(80))).toBe('bedrock');
  });
});
