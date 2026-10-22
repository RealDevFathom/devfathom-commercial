import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIUnavailableError, type AIModelSelection } from './provider';
import { karachiMonthBounds, routeAI, type AIRouterDependencies } from './router';
import { DEFAULT_AI_ROUTING_SETTINGS, type AIRoutingSettings } from './spend';

vi.mock('server-only', () => ({}));
vi.mock('./provider', async (original) => ({ ...(await original<typeof import('./provider')>()), getModelForTier: vi.fn() }));
vi.mock('./spend', async (original) => ({
  ...(await original<typeof import('./spend')>()),
  readAIRoutingSettings: vi.fn(), readProviderSpend: vi.fn(), recordAIUsage: vi.fn(),
}));

const selection = (provider: 'anthropic' | 'bedrock'): AIModelSelection => ({
  model: {} as AIModelSelection['model'], provider, modelId: `${provider}-model`,
});

function harness(overrides: Partial<AIRouterDependencies> = {}, settings: AIRoutingSettings = DEFAULT_AI_ROUTING_SETTINGS) {
  const record = vi.fn(async () => undefined);
  const deps: AIRouterDependencies = {
    now: () => new Date('2026-10-31T19:00:00.000Z'),
    settings: async () => settings,
    spend: vi.fn(async () => 0),
    model: (provider) => selection(provider), record,
    ...overrides,
  };
  return { deps, record };
}

async function routed(deps: AIRouterDependencies, execute = vi.fn(async (model: AIModelSelection) => ({
  value: model.provider, usage: { inputTokens: 100, outputTokens: 20 },
}))) {
  return { value: await routeAI({ tier: 'standard', feature: 'growth', organizationId: 'org-1', execute, dependencies: deps }), execute };
}

describe('AI router', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([[199.99, 'anthropic'], [200, 'bedrock'], [200.01, 'bedrock']] as const)(
    'crosses over at the budget boundary (%s)', async (spent, expected) => {
      const { deps } = harness({ spend: vi.fn(async () => spent) });
      expect((await routed(deps)).value).toBe(expected);
    }
  );

  it.each([
    [{ status: 429 }, '429'], [{ status: 500 }, '500'], [{ statusCode: 503 }, '503'],
    [{ code: 'credit_balance_exhausted' }, 'credit'], [{ type: 'billing_error' }, 'billing'],
  ])('fails over for %s', async (failure) => {
    const { deps } = harness();
    const execute = vi.fn(async (model: AIModelSelection) => {
      if (model.provider === 'anthropic') throw failure;
      return { value: 'bedrock', usage: { inputTokens: 2, outputTokens: 1 } };
    });
    expect((await routed(deps, execute)).value).toBe('bedrock');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not fail over a 400', async () => {
    const { deps } = harness();
    const execute = vi.fn(async () => { throw { status: 400 }; });
    await expect(routed(deps, execute)).rejects.toEqual({ status: 400 });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('does not fail over ForceAnthropic', async () => {
    const settings = { ...DEFAULT_AI_ROUTING_SETTINGS, mode: 'ForceAnthropic' as const };
    const { deps } = harness({}, settings);
    const execute = vi.fn(async () => { throw { status: 503 }; });
    await expect(routed(deps, execute)).rejects.toEqual({ status: 503 });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('resets at midnight on the first in PKT, not UTC', async () => {
    expect(karachiMonthBounds(new Date('2026-10-31T18:59:59.999Z')).from.toISOString()).toBe('2026-09-30T19:00:00.000Z');
    expect(karachiMonthBounds(new Date('2026-10-31T19:00:00.000Z')).from.toISOString()).toBe('2026-10-31T19:00:00.000Z');
  });

  it('surfaces a clear Disabled error', async () => {
    const { deps } = harness({}, { ...DEFAULT_AI_ROUTING_SETTINGS, mode: 'Disabled' });
    await expect(routed(deps)).rejects.toMatchObject({ name: 'AIUnavailableError', reason: 'DISABLED', message: expect.stringContaining('disabled') } satisfies Partial<AIUnavailableError>);
  });

  it('records token usage for success and a billed failed attempt', async () => {
    const { deps, record } = harness();
    const error = Object.assign(new Error('billing'), { status: 503, usage: { inputTokens: 7, outputTokens: 3 } });
    const execute = vi.fn(async (model: AIModelSelection) => {
      if (model.provider === 'anthropic') throw error;
      return { value: 'ok', usage: { inputTokens: 11, outputTokens: 5 } };
    });
    await routed(deps, execute);
    expect(record).toHaveBeenNthCalledWith(1, expect.objectContaining({ provider: 'anthropic', inputTokens: 7, outputTokens: 3 }));
    expect(record).toHaveBeenNthCalledWith(2, expect.objectContaining({ provider: 'bedrock', inputTokens: 11, outputTokens: 5 }));
  });
});

describe('usage cost', () => {
  it('computes USD from input and output per-million-token prices', async () => {
    const { computeAIUsageCost } = await import('./spend');
    expect(computeAIUsageCost(1_000_000, 500_000, 3, 15)).toBe(10.5);
  });
});
