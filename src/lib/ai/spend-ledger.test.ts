import { beforeEach, describe, expect, it, vi } from 'vitest';

type PriceRow = {
  provider: string;
  model: string;
  effectiveFrom: Date;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
};
type UsageRow = { provider: string; costUsd: number; createdAt: Date };

const store = vi.hoisted(() => ({
  prices: [] as PriceRow[],
  usage: [] as UsageRow[],
}));

// In-memory stand-in for the platform database: it interprets the two ledger
// queries so recordProviderUsage / readProviderSpend run for real.
vi.mock('@/lib/tenancy/scoped-db', () => {
  const db = {
    $queryRaw: async (query: { sql: string; values: unknown[] }) => {
      if (query.sql.includes('ai_model_prices')) {
        const [provider, model, at] = query.values as [string, string, Date];
        const rows = store.prices
          .filter(
            (p) =>
              p.provider === provider &&
              p.model === model &&
              p.effectiveFrom.getTime() <= at.getTime()
          )
          .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
        return rows.slice(0, 1);
      }
      const [provider, from, to] = query.values as [string, Date, Date];
      const total = store.usage
        .filter((u) => u.provider === provider && u.createdAt >= from && u.createdAt < to)
        .reduce((sum, u) => sum + u.costUsd, 0);
      return [{ total }];
    },
    $executeRaw: async (query: { values: unknown[] }) => {
      const v = query.values;
      store.usage.push({
        provider: v[1] as string,
        costUsd: v[8] as number,
        createdAt: v[9] as Date,
      });
      return 1;
    },
  };
  return {
    withPlatformDb: async (run: (d: typeof db) => unknown) => run(db),
    withTenantDb: vi.fn(),
  };
});

import { FALLBACK_PRICE_USD_PER_MTOK, listPriceFor } from './model-defaults';
import { computeAIUsageCost, readProviderSpend, recordProviderUsage } from './spend';

const base = {
  tier: 'standard' as const,
  feature: 'test',
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
};
const T = (iso: string) => new Date(iso);

beforeEach(() => {
  store.prices = [];
  store.usage = [];
});

describe('unknown-model fallback price', () => {
  it('prices an unknown model at the provider fallback, not the Sonnet list price', async () => {
    const cost = await recordProviderUsage({
      ...base,
      provider: 'anthropic',
      model: 'claude-unknown-9',
    });
    const fb = FALLBACK_PRICE_USD_PER_MTOK.anthropic;
    expect(cost).toBe(fb.input + fb.output);
    expect(cost).toBe(90);
  });

  it('uses the list price for a known model and the Bedrock fallback for unknown Bedrock models', async () => {
    expect(
      await recordProviderUsage({ ...base, provider: 'anthropic', model: 'claude-sonnet-5-5' })
    ).toBe(12);
    expect(await recordProviderUsage({ ...base, provider: 'bedrock', model: 'mystery' })).toBe(99);
    expect(listPriceFor('openai', 'nope')).toEqual(FALLBACK_PRICE_USD_PER_MTOK.openai);
  });
});

describe('effective-date precedence of price rows', () => {
  const row = (effectiveFrom: string, input: number, output: number): PriceRow => ({
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    effectiveFrom: T(effectiveFrom),
    inputUsdPerMTok: input,
    outputUsdPerMTok: output,
  });

  it('uses the latest row effective at the call time', async () => {
    store.prices = [row('2026-01-01T00:00:00Z', 1, 2), row('2026-06-01T00:00:00Z', 5, 6)];
    const at = (iso: string) => ({
      ...base,
      provider: 'anthropic' as const,
      model: 'claude-sonnet-5-5',
      createdAt: T(iso),
    });
    expect(await recordProviderUsage(at('2026-07-01T00:00:00Z'))).toBe(11);
    expect(await recordProviderUsage(at('2026-03-01T00:00:00Z'))).toBe(3);
  });

  it('ignores rows that are not effective yet and falls back to the list price', async () => {
    store.prices = [row('2027-01-01T00:00:00Z', 100, 100)];
    const cost = await recordProviderUsage({
      ...base,
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      createdAt: T('2026-11-01T00:00:00Z'),
    });
    expect(cost).toBe(12);
  });

  it('applies a row exactly at its effectiveFrom instant', async () => {
    store.prices = [row('2026-06-01T00:00:00Z', 5, 6)];
    const cost = await recordProviderUsage({
      ...base,
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      createdAt: T('2026-06-01T00:00:00Z'),
    });
    expect(cost).toBe(11);
  });
});

describe('decimal rounding', () => {
  it('keeps fractional-cent costs without rounding them away', () => {
    expect(computeAIUsageCost(1, 1, 2, 10)).toBeCloseTo(0.000012, 12);
    expect(computeAIUsageCost(333, 777, 0.1, 0.5)).toBeCloseTo(0.0004218, 10);
  });

  it('truncates fractional and negative token counts before pricing', async () => {
    const cost = await recordProviderUsage({
      ...base,
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      inputTokens: 500_000.9,
      outputTokens: -50,
    });
    expect(cost).toBe(1);
    const zero = await recordProviderUsage({
      ...base,
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      inputTokens: -1,
      outputTokens: 0.4,
    });
    expect(zero).toBe(0);
  });
});

describe('budget decision driven by recorded costs', () => {
  const bounds = { from: T('2026-11-01T00:00:00Z'), to: T('2026-12-01T00:00:00Z') };
  const call = (model: string, createdAt: string, inputTokens = 1_000_000) =>
    recordProviderUsage({
      ...base,
      provider: 'anthropic',
      model,
      inputTokens,
      outputTokens: 0,
      createdAt: T(createdAt),
    });

  it('trips the cap early because unknown models are priced high', async () => {
    const cap = 20;
    await call('claude-sonnet-5-5', '2026-11-05T00:00:00Z'); // $2
    expect(await readProviderSpend('anthropic', bounds.from, bounds.to)).toBe(2);
    expect((await readProviderSpend('anthropic', bounds.from, bounds.to)) >= cap).toBe(false);

    await call('claude-unknown-9', '2026-11-06T00:00:00Z'); // $15 fallback
    const spent = await readProviderSpend('anthropic', bounds.from, bounds.to);
    expect(spent).toBe(17);
    expect(spent >= cap).toBe(false);

    await call('claude-unknown-9', '2026-11-07T00:00:00Z');
    expect((await readProviderSpend('anthropic', bounds.from, bounds.to)) >= cap).toBe(true);
  });

  it('counts only the requested provider and month', async () => {
    await call('claude-sonnet-5-5', '2026-10-31T23:00:00Z');
    await recordProviderUsage({
      ...base,
      provider: 'openai',
      model: 'gpt-6-luna',
      createdAt: T('2026-11-05T00:00:00Z'),
    });
    expect(await readProviderSpend('anthropic', bounds.from, bounds.to)).toBe(0);
    expect(await readProviderSpend('openai', bounds.from, bounds.to)).toBeCloseTo(0.6, 10);
  });
});
