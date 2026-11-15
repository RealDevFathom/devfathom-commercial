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
  priceQueries: [] as string[],
}));

// In-memory stand-in for the platform database: it interprets the two ledger
// queries so recordProviderUsage / readProviderSpend run for real.
vi.mock('@/lib/tenancy/scoped-db', () => {
  const db = {
    $queryRaw: async (query: { sql: string; values: unknown[] }) => {
      if (query.sql.includes('ai_model_prices')) {
        store.priceQueries.push(query.sql.replace(/\s+/g, ' ').trim());
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

import {
  DEFAULT_MODEL_PRICES_USD_PER_MTOK,
  FALLBACK_PRICE_USD_PER_MTOK,
  listPriceFor,
  type TieredAIProviderName,
} from './model-defaults';
import { __setRouterDependenciesForTests, readRoutedAvailability } from './router';
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
  store.priceQueries = [];
  __setRouterDependenciesForTests(null);
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

describe('every default model list price', () => {
  it.each(Object.entries(DEFAULT_MODEL_PRICES_USD_PER_MTOK))(
    'records %s at its own list price, below the provider fallback',
    async (key, price) => {
      const [provider, ...rest] = key.split(':');
      const model = rest.join(':');
      const cost = await recordProviderUsage({
        ...base,
        provider: provider as TieredAIProviderName,
        model,
      });
      expect(cost).toBe(price.input + price.output);
      const fb = FALLBACK_PRICE_USD_PER_MTOK[provider as TieredAIProviderName];
      expect(cost).toBeLessThan(fb.input + fb.output);
    }
  );
});

describe('effective-date precedence of price rows', () => {
  it('queries rows effective at or before the call time, newest first', async () => {
    await recordProviderUsage({ ...base, provider: 'anthropic', model: 'claude-sonnet-5-5' });
    const sql = store.priceQueries[0];
    expect(sql).toContain('"effectiveFrom" <= ');
    expect(sql).toContain('ORDER BY "effectiveFrom" DESC LIMIT 1');
  });

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
  // Only Anthropic is configured, so the real router has nowhere to fail over to.
  const ENV = {
    NODE_ENV: 'production',
    AI_PROVIDER: 'auto',
    ANTHROPIC_API_KEY_SECRET_ID: 'devfathom/staging/anthropic-api-key',
    AI_ANTHROPIC_MONTHLY_CAP_USD: '20',
  };
  const bounds = { from: T('2026-11-01T00:00:00Z'), to: T('2026-12-01T00:00:00Z') };
  const call = (model: string, createdAt: string) =>
    recordProviderUsage({
      ...base,
      provider: 'anthropic',
      model,
      inputTokens: 1_000_000,
      outputTokens: 0,
      createdAt: T(createdAt),
    });

  beforeEach(() => {
    // The real ledger functions feed the real router cap check.
    __setRouterDependenciesForTests({
      now: () => T('2026-11-10T12:00:00Z'),
      storedSettings: async () => null,
      spend: readProviderSpend,
      record: recordProviderUsage,
      apiKey: async () => 'key',
    });
  });

  it('trips the router cap early because unknown models are priced high', async () => {
    await call('claude-sonnet-5-5', '2026-11-05T00:00:00Z'); // $2
    await call('claude-unknown-9', '2026-11-06T00:00:00Z'); // $15 fallback
    expect(await readProviderSpend('anthropic', bounds.from, bounds.to)).toBe(17);
    await expect(readRoutedAvailability(ENV)).resolves.toEqual({ available: true });

    await call('claude-unknown-9', '2026-11-07T00:00:00Z'); // $32 >= $20 cap
    await expect(readRoutedAvailability(ENV)).resolves.toEqual({
      available: false,
      reason: 'CAPPED',
    });
  });

  it('keeps the provider available when the same traffic is on the cheap known model', async () => {
    for (const day of ['05', '06', '07'])
      await call('claude-haiku-5-5', `2026-11-${day}T00:00:00Z`);
    await expect(readRoutedAvailability(ENV)).resolves.toEqual({ available: true });
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
