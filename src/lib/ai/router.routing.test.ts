import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import { generateText, streamText } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TieredAIProviderName } from './model-defaults';
import { AIUnavailableError, createAIModel } from './provider';
import {
  __setRouterDependenciesForTests,
  candidateChain,
  karachiMonthBounds,
  readRoutedAvailability,
  resolveRoutingSettings,
  type RouterDependencies,
} from './router';
import type { StoredAISettings } from './spend';

type Provider = TieredAIProviderName;

const ENV = {
  NODE_ENV: 'production',
  AI_PROVIDER: 'auto',
  ANTHROPIC_API_KEY_SECRET_ID: 'devfathom/staging/anthropic-api-key',
  OPENAI_API_KEY_SECRET_ID: 'devfathom/staging/openai-api-key',
  BEDROCK_REGION: 'us-east-1',
};

const usage = (input: number, output: number): LanguageModelV3Usage => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

type Behaviour = 'ok' | { error: unknown };

function fakeModel(provider: Provider, modelId: string, behaviour: Behaviour, calls: string[]) {
  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider,
    modelId,
    supportedUrls: {},
    async doGenerate(options: LanguageModelV3CallOptions) {
      calls.push(
        `${provider}:${modelId}:${JSON.stringify(options.providerOptions?.openai ?? null)}`
      );
      if (behaviour !== 'ok') throw behaviour.error;
      return {
        content: [{ type: 'text', text: `answer from ${provider}` }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: usage(1000, 500),
        warnings: [],
      } as never;
    },
    async doStream(options: LanguageModelV3CallOptions) {
      calls.push(
        `${provider}:${modelId}:${JSON.stringify(options.providerOptions?.openai ?? null)}`
      );
      if (behaviour !== 'ok') throw behaviour.error;
      const parts: LanguageModelV3StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: `streamed from ${provider}` },
        { type: 'text-end', id: 't' },
        {
          type: 'finish',
          usage: usage(200, 100),
          finishReason: { unified: 'stop', raw: 'stop' },
        } as never,
      ];
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
  return model;
}

function setup(options: {
  behaviours?: Partial<Record<Provider, Behaviour>>;
  spend?: Partial<Record<Provider, number>>;
  stored?: StoredAISettings | null;
  keys?: Partial<Record<'anthropic' | 'openai', string | null>>;
  spendFails?: boolean;
}) {
  const calls: string[] = [];
  const recorded: Array<Record<string, unknown>> = [];
  const alerts: Provider[] = [];
  const deps: Partial<RouterDependencies> = {
    now: () => new Date('2026-11-02T12:00:00Z'),
    storedSettings: async () => options.stored ?? null,
    spend: async (provider) => {
      if (options.spendFails) throw new Error('db down');
      return options.spend?.[provider] ?? 0;
    },
    apiKey: async (provider) =>
      provider in (options.keys ?? {}) ? options.keys![provider]! : `key-${provider}`,
    model: ({ provider, modelId }) =>
      fakeModel(provider, modelId, options.behaviours?.[provider] ?? 'ok', calls),
    record: async (row) => {
      recorded.push(row as never);
      return 0;
    },
    alert: async (provider) => {
      alerts.push(provider);
    },
  };
  __setRouterDependenciesForTests(deps);
  return { calls, recorded, alerts };
}

const stored = (overrides: Partial<StoredAISettings>): StoredAISettings => ({
  mode: 'Auto',
  providerOrder: [],
  fallbackEnabled: true,
  capsUsd: {},
  models: { anthropic: {}, openai: {}, bedrock: {} },
  updatedAt: new Date('2026-11-01T00:00:00Z'),
  updatedBy: 'operator-1',
  ...overrides,
});

const generate = (env: Record<string, string | undefined> = ENV, feature = 'ask-fathom') =>
  generateText({
    model: createAIModel(env, { feature, organizationId: 'org-1' }).model,
    prompt: 'hello',
    maxRetries: 0,
  });

afterEach(() => {
  __setRouterDependenciesForTests(null);
  vi.restoreAllMocks();
});

describe('routing policy', () => {
  it('defaults to anthropic → openai → bedrock with the default caps and current models', () => {
    const settings = resolveRoutingSettings(null, {});
    expect(settings).toMatchObject({
      mode: 'Auto',
      providerOrder: ['anthropic', 'openai', 'bedrock'],
      fallbackEnabled: true,
      capsUsd: { anthropic: 190, openai: 190, bedrock: 300 },
      source: 'environment',
    });
    expect(settings.models.anthropic.standard).toBe('claude-sonnet-5-5');
    expect(settings.models.bedrock.deep).toBe('us.anthropic.claude-opus-5-5');
  });

  it('lets the environment and then the SuperAdmin override order, caps and models', () => {
    const env = {
      AI_PROVIDER_ORDER: 'openai,bedrock',
      AI_OPENAI_MONTHLY_CAP_USD: '50',
      AI_ANTHROPIC_MODEL_CHEAP: 'env-cheap',
    };
    expect(resolveRoutingSettings(null, env)).toMatchObject({
      providerOrder: ['openai', 'bedrock'],
      capsUsd: { openai: 50 },
      models: { anthropic: { cheap: 'env-cheap' } },
    });
    const saved = resolveRoutingSettings(
      stored({
        providerOrder: ['bedrock', 'anthropic'],
        capsUsd: { openai: 10 },
        models: { anthropic: { cheap: 'admin-cheap' }, openai: {}, bedrock: {} },
      }),
      env
    );
    expect(saved).toMatchObject({
      providerOrder: ['bedrock', 'anthropic'],
      capsUsd: { openai: 10, anthropic: 190 },
      models: { anthropic: { cheap: 'admin-cheap' } },
      source: 'superadmin',
    });
  });

  it.each([
    ['Auto', {}, ['anthropic', 'openai', 'bedrock']],
    ['Auto', { AI_PROVIDER: 'openai' }, ['openai', 'anthropic', 'bedrock']],
    ['ForceBedrock', { AI_PROVIDER: 'openai' }, ['bedrock', 'anthropic', 'openai']],
    ['ForceOpenAI', {}, ['openai', 'anthropic', 'bedrock']],
    ['Disabled', {}, []],
  ] as const)('mode %s with %j tries %j', (mode, env, expected) => {
    expect(candidateChain(resolveRoutingSettings(stored({ mode }), env), env)).toEqual(expected);
  });

  it('tries only the first provider when fallback is off', () => {
    expect(
      candidateChain(
        resolveRoutingSettings(stored({ mode: 'ForceOpenAI', fallbackEnabled: false }), {}),
        {}
      )
    ).toEqual(['openai']);
  });

  it('never puts Azure in the chain, whatever the order or selector says', () => {
    const env = { AI_PROVIDER_ORDER: 'azure,anthropic', AI_PROVIDER: 'auto' };
    expect(candidateChain(resolveRoutingSettings(null, env), env)).toEqual(['anthropic']);
  });

  it('bounds the month in Asia/Karachi', () => {
    expect(karachiMonthBounds(new Date('2026-10-31T20:00:00Z'))).toEqual({
      from: new Date('2026-10-31T19:00:00Z'),
      to: new Date('2026-11-30T19:00:00Z'),
    });
  });
});

describe('fallback chain', () => {
  it('answers from the first provider and records its priced usage', async () => {
    const { calls, recorded, alerts } = setup({});
    const result = await generate();
    expect(result.text).toBe('answer from anthropic');
    expect(calls).toEqual(['anthropic:claude-sonnet-5-5:null']);
    expect(recorded).toEqual([
      expect.objectContaining({
        provider: 'anthropic',
        tier: 'standard',
        model: 'claude-sonnet-5-5',
        feature: 'ask-fathom',
        organizationId: 'org-1',
        inputTokens: 1000,
        outputTokens: 500,
      }),
    ]);
    expect(alerts).toEqual(['anthropic']);
    expect(result.providerMetadata?.devfathomRouting).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-5-5',
    });
  });

  it('falls back to OpenAI (store: false) when Anthropic fails, then to Bedrock', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const overloaded = Object.assign(new Error('overloaded'), {
      name: 'AI_APICallError',
      statusCode: 529,
    });
    const { calls, recorded } = setup({ behaviours: { anthropic: { error: overloaded } } });
    await expect(generate()).resolves.toMatchObject({ text: 'answer from openai' });
    expect(calls).toEqual([
      'anthropic:claude-sonnet-5-5:null',
      'openai:gpt-5.4-mini:{"store":false}',
    ]);
    expect(recorded.map((row) => row.provider)).toEqual(['openai']);

    const failing = setup({
      behaviours: { anthropic: { error: overloaded }, openai: { error: new Error('auth') } },
    });
    await expect(generate()).resolves.toMatchObject({ text: 'answer from bedrock' });
    expect(failing.calls.map((call) => call.split(':')[0])).toEqual([
      'anthropic',
      'openai',
      'bedrock',
    ]);
  });

  it('skips a provider with no configured key without calling it', async () => {
    const { calls } = setup({ keys: { anthropic: null } });
    await expect(generate()).resolves.toMatchObject({ text: 'answer from openai' });
    expect(calls.map((call) => call.split(':')[0])).toEqual(['openai']);
    const env = {
      ...ENV,
      ANTHROPIC_API_KEY_SECRET_ID: undefined,
      OPENAI_API_KEY_SECRET_ID: undefined,
    };
    setup({});
    await expect(generate(env)).resolves.toMatchObject({ text: 'answer from bedrock' });
  });

  it('skips a provider at its monthly cap and uses the next', async () => {
    const { calls } = setup({ spend: { anthropic: 190 } });
    await expect(generate()).resolves.toMatchObject({ text: 'answer from openai' });
    expect(calls.map((call) => call.split(':')[0])).toEqual(['openai']);
  });

  it('is unavailable (CAPPED) when every provider is at its cap', async () => {
    const { calls } = setup({ spend: { anthropic: 190, openai: 200, bedrock: 300 } });
    await expect(generate()).rejects.toMatchObject({
      name: 'AIUnavailableError',
      reason: 'CAPPED',
    });
    expect(calls).toEqual([]);
    await expect(readRoutedAvailability(ENV)).resolves.toEqual({
      available: false,
      reason: 'CAPPED',
    });
  });

  it('treats unreadable spend as capped rather than spending blind', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { calls } = setup({ spendFails: true });
    await expect(generate()).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('is unavailable (PROVIDERS_FAILED) when every attempt fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const boom = { error: new Error('down') };
    setup({ behaviours: { anthropic: boom, openai: boom, bedrock: boom } });
    await expect(generate()).rejects.toMatchObject({
      name: 'AIUnavailableError',
      reason: 'PROVIDERS_FAILED',
    });
  });

  it('honours the SuperAdmin switch: forced provider first, and Disabled turns AI off', async () => {
    const forced = setup({ stored: stored({ mode: 'ForceBedrock' }) });
    await expect(generate()).resolves.toMatchObject({ text: 'answer from bedrock' });
    expect(forced.calls[0]).toMatch(/^bedrock:us\.anthropic\.claude-sonnet-5-5/);

    const disabled = setup({ stored: stored({ mode: 'Disabled' }) });
    await expect(generate()).rejects.toMatchObject({
      name: 'AIUnavailableError',
      reason: 'DISABLED',
    });
    expect(disabled.calls).toEqual([]);
    await expect(readRoutedAvailability(ENV)).resolves.toEqual({
      available: false,
      reason: 'DISABLED',
    });
  });

  it('uses the SuperAdmin model for the tier', async () => {
    const { calls } = setup({
      stored: stored({
        models: { anthropic: { standard: 'admin-model' }, openai: {}, bedrock: {} },
      }),
    });
    await generate();
    expect(calls[0]).toBe('anthropic:admin-model:null');
  });

  it('never retries a cancelled call on another provider', async () => {
    const controller = new AbortController();
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { calls } = setup({ behaviours: { anthropic: { error: abort } } });
    controller.abort();
    await expect(
      generateText({
        model: createAIModel(ENV, { feature: 'ask-fathom' }).model,
        prompt: 'x',
        maxRetries: 0,
        abortSignal: controller.signal,
      })
    ).rejects.toThrow();
    expect(calls.filter((call) => !call.startsWith('anthropic'))).toEqual([]);
  });

  it('returns paid output even when the ledger write fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setup({});
    __setRouterDependenciesForTests({
      now: () => new Date('2026-11-02T12:00:00Z'),
      storedSettings: async () => null,
      spend: async () => 0,
      apiKey: async () => 'k',
      model: ({ provider, modelId }) => fakeModel(provider, modelId, 'ok', []),
      record: async () => {
        throw new Error('ledger down');
      },
    });
    await expect(generate()).resolves.toMatchObject({ text: 'answer from anthropic' });
  });
});

describe('streaming', () => {
  it('fails over before the stream starts and meters the finished stream', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { calls, recorded } = setup({ behaviours: { anthropic: { error: new Error('503') } } });
    const result = streamText({
      model: createAIModel(ENV, { feature: 'ask-fathom', organizationId: 'org-1' }).model,
      prompt: 'hello',
      maxRetries: 0,
    });
    await expect(result.text).resolves.toBe('streamed from openai');
    expect(calls.map((call) => call.split(':')[0])).toEqual(['anthropic', 'openai']);
    expect(recorded).toEqual([
      expect.objectContaining({ provider: 'openai', inputTokens: 200, outputTokens: 100 }),
    ]);
  });
});

describe('unavailable errors', () => {
  it('exposes a stable reason for callers', () => {
    expect(new AIUnavailableError('CAPPED').reason).toBe('CAPPED');
  });
});
