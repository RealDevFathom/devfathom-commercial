import { Prisma } from '@/generated/prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_AI_MODELS } from './model-defaults';
import {
  UnknownAIModelPriceError,
  calculateAIUsageCost,
  recordAIUsage,
  type ModelPrice,
} from './spend';

const rates = new Map([
  ['cheap', ['1', '5']],
  ['standard', ['3', '15']],
  ['deep', ['15', '75']],
]);

describe('AI usage pricing', () => {
  it.each(
    Object.entries(DEFAULT_AI_MODELS).flatMap(([provider, models]) =>
      Object.entries(models).map(([modelClass, model]) => [provider, modelClass, model] as const)
    )
  )('prices the default %s/%s model from its catalog row', async (provider, modelClass, model) => {
    const [inputRate, outputRate] = rates.get(modelClass)!;
    const ledger = { create: vi.fn() };
    const prices = {
      findFirst: vi.fn().mockResolvedValue({
        provider,
        model,
        inputUsdPerMillionTokens: inputRate,
        outputUsdPerMillionTokens: outputRate,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      }),
    };

    await expect(
      recordAIUsage({
        prices,
        ledger,
        provider,
        model,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      })
    ).resolves.toEqual(new Prisma.Decimal(inputRate).plus(outputRate));
    expect(ledger.create).toHaveBeenCalledOnce();
  });

  it('selects the newest price effective at the usage timestamp', async () => {
    const rows: ModelPrice[] = [
      {
        provider: 'anthropic',
        model: 'model',
        inputUsdPerMillionTokens: '2',
        outputUsdPerMillionTokens: '4',
        effectiveFrom: new Date('2026-06-01'),
      },
      {
        provider: 'anthropic',
        model: 'model',
        inputUsdPerMillionTokens: '1',
        outputUsdPerMillionTokens: '3',
        effectiveFrom: new Date('2026-01-01'),
      },
    ];
    const prices = {
      findFirst: vi.fn(
        async ({ where }: Parameters<import('./spend').UsagePriceCatalog['findFirst']>[0]) =>
          rows
            .filter((row) => row.effectiveFrom <= where.effectiveFrom.lte)
            .sort((a, b) => +b.effectiveFrom - +a.effectiveFrom)[0] ?? null
      ),
    };
    await expect(
      recordAIUsage({
        prices,
        ledger: { create: vi.fn() },
        provider: 'anthropic',
        model: 'model',
        inputTokens: 1_000_000,
        outputTokens: 0,
        occurredAt: new Date('2026-07-01'),
      })
    ).resolves.toEqual(new Prisma.Decimal(2));
    expect(prices.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { effectiveFrom: 'desc' } })
    );
  });

  it('uses exact decimal arithmetic and rounds half up to the ledger scale', () => {
    expect(
      calculateAIUsageCost(
        { inputUsdPerMillionTokens: '1', outputUsdPerMillionTokens: '5' },
        1,
        1
      ).toFixed(6)
    ).toBe('0.000006');
    expect(
      calculateAIUsageCost(
        { inputUsdPerMillionTokens: '1.25', outputUsdPerMillionTokens: '0' },
        1,
        0
      ).toFixed(6)
    ).toBe('0.000001');
  });

  it('fails closed without writing when the exact model has no effective price', async () => {
    const ledger = { create: vi.fn() };
    await expect(
      recordAIUsage({
        prices: { findFirst: vi.fn().mockResolvedValue(null) },
        ledger,
        provider: 'anthropic',
        model: 'unknown',
        inputTokens: 1,
        outputTokens: 1,
      })
    ).rejects.toBeInstanceOf(UnknownAIModelPriceError);
    expect(ledger.create).not.toHaveBeenCalled();
  });
});
