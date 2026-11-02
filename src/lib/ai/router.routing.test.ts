import {
  APICallError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3FinishReason,
  type LanguageModelV3StreamPart,
  type LanguageModelV3Usage,
} from '@ai-sdk/provider';
import { generateText, streamText } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TieredAIProviderName } from './model-defaults';
import { AIUnavailableError, createAIModel } from './provider';
import {
  CIRCUIT_LONG_OPEN_MS,
  CIRCUIT_OPEN_MS,
  __setRouterDependenciesForTests,
  candidateChain,
  karachiMonthBounds,
  readRoutedAvailability,
  resolveRoutingSettings,
  type RouterDependencies,
} from './router';
import type { StoredAISettings } from './spend';
import type { AITier } from './tiers';
import { createTurnBudget, type TurnBudget } from './turn-budget';

type Provider = TieredAIProviderName;

const ENV = {
  NODE_ENV: 'production',
  AI_PROVIDER: 'auto',
  ANTHROPIC_API_KEY_SECRET_ID: 'devfathom/staging/anthropic-api-key',
  OPENAI_API_KEY_SECRET_ID: 'devfathom/staging/openai-api-key',
  BEDROCK_REGION: 'ap-southeast-1',
};
const HAIKU_ON = { ...ENV, AF_HAIKU_LOOKUPS: 'true' };

const usage = (input: number, output: number): LanguageModelV3Usage => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

/** One call's behaviour: answer normally, throw, or answer with a given shape. */
type Step =
  | 'ok'
  | { error: unknown }
  | { text?: string; finish?: LanguageModelV3FinishReason['unified']; toolCall?: boolean };
type Behaviour = Step | Step[];

type Call = { provider: Provider; modelId: string; options: LanguageModelV3CallOptions };

function stepFor(behaviour: Behaviour, index: number): Step {
  if (!Array.isArray(behaviour)) return behaviour;
  return behaviour[Math.min(index, behaviour.length - 1)];
}

function fakeModel(
  provider: Provider,
  modelId: string,
  behaviour: Behaviour,
  calls: string[],
  log: Call[]
) {
  const shape = (options: LanguageModelV3CallOptions) => {
    const index = log.filter((call) => call.provider === provider).length;
    calls.push(`${provider}:${modelId}:${JSON.stringify(options.providerOptions?.openai ?? null)}`);
    log.push({ provider, modelId, options });
    const step = stepFor(behaviour, index);
    if (step !== 'ok' && 'error' in step) throw step.error;
    return step === 'ok' ? {} : step;
  };
  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider,
    modelId,
    supportedUrls: {},
    async doGenerate(options: LanguageModelV3CallOptions) {
      const step = shape(options);
      const text = step.text ?? `answer from ${provider}`;
      return {
        content: [
          ...(text ? [{ type: 'text' as const, text }] : []),
          ...(step.toolCall
            ? [{ type: 'tool-call' as const, toolCallId: 'c1', toolName: 'lookup', input: '{}' }]
            : []),
        ],
        finishReason: { unified: step.finish ?? 'stop', raw: step.finish ?? 'stop' },
        usage: usage(1000, 500),
        warnings: [],
      } as never;
    },
    async doStream(options: LanguageModelV3CallOptions) {
      const step = shape(options);
      const text = step.text ?? `streamed from ${provider}`;
      const parts: LanguageModelV3StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        ...(text
          ? ([
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: text },
              { type: 'text-end', id: 't' },
            ] as LanguageModelV3StreamPart[])
          : []),
        {
          type: 'finish',
          usage: usage(200, 100),
          finishReason: { unified: step.finish ?? 'stop', raw: step.finish ?? 'stop' },
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

function setup(
  options: {
    behaviours?: Partial<Record<Provider, Behaviour>>;
    spend?: Partial<Record<Provider, number>>;
    stored?: StoredAISettings | null;
    keys?: Partial<Record<'anthropic' | 'openai', string | null>>;
    spendFails?: boolean;
    deepStrategy?: boolean | 'fails';
    /** Use the router's real (timer-based) sleep, for fake-timer tests. */
    realSleep?: boolean;
    random?: number;
  } = {}
) {
  const calls: string[] = [];
  const log: Call[] = [];
  const recorded: Array<Record<string, unknown>> = [];
  const alerts: Provider[] = [];
  const authAlerts: Array<{ provider: Provider; at: string }> = [];
  const sleeps: number[] = [];
  const optInReads: string[] = [];
  const clock = { now: new Date('2026-11-02T12:00:00Z') };
  const deps: Partial<RouterDependencies> = {
    now: () => clock.now,
    storedSettings: async () => options.stored ?? null,
    spend: async (provider) => {
      if (options.spendFails) throw new Error('db down');
      return options.spend?.[provider] ?? 0;
    },
    apiKey: async (provider) =>
      provider in (options.keys ?? {}) ? options.keys![provider]! : `key-${provider}`,
    model: ({ provider, modelId }) =>
      fakeModel(provider, modelId, options.behaviours?.[provider] ?? 'ok', calls, log),
    record: async (row) => {
      recorded.push(row as never);
      return 0;
    },
    alert: async (provider) => {
      alerts.push(provider);
    },
    authAlert: async (provider, now) => {
      authAlerts.push({ provider, at: now.toISOString() });
    },
    deepStrategyEnabled: async (organizationId) => {
      optInReads.push(organizationId);
      if (options.deepStrategy === 'fails') throw new Error('tenant db down');
      return options.deepStrategy === true;
    },
    ...(options.realSleep
      ? {}
      : {
          sleep: async (ms: number) => {
            sleeps.push(ms);
          },
        }),
    random: () => options.random ?? 0.5,
  };
  __setRouterDependenciesForTests(deps);
  const advance = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
  };
  const behaviours = (options.behaviours ??= {});
  return { calls, log, recorded, alerts, authAlerts, sleeps, optInReads, advance, behaviours };
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

const generate = (
  env: Record<string, string | undefined> = ENV,
  feature = 'ask-fathom',
  extra: { tier?: AITier; turn?: TurnBudget; prompt?: string } = {}
) =>
  generateText({
    model: createAIModel(env, {
      feature,
      organizationId: 'org-1',
      tier: extra.tier,
      turn: extra.turn,
    }).model,
    prompt: extra.prompt ?? 'hello',
    maxRetries: 0,
  });

const providers = (calls: string[]) => calls.map((call) => call.split(':')[0]);
const models = (calls: string[]) => calls.map((call) => call.split(':').slice(0, 2).join(':'));

const apiError = (
  statusCode: number | undefined,
  extra: Partial<{
    headers: Record<string, string>;
    body: string;
    isRetryable: boolean;
  }> = {}
) =>
  new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'https://provider.invalid',
    requestBodyValues: {},
    statusCode,
    responseHeaders: extra.headers,
    responseBody: extra.body,
    isRetryable: extra.isRetryable,
  });

afterEach(() => {
  __setRouterDependenciesForTests(null);
  vi.restoreAllMocks();
});

const quiet = () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
};

describe('routing policy', () => {
  it('defaults to anthropic → openai → bedrock with the default caps and the decided models', () => {
    const settings = resolveRoutingSettings(null, {});
    expect(settings).toMatchObject({
      mode: 'Auto',
      providerOrder: ['anthropic', 'openai', 'bedrock'],
      fallbackEnabled: true,
      capsUsd: { anthropic: 190, openai: 190, bedrock: 300 },
      source: 'environment',
    });
    expect(settings.models.anthropic.standard).toBe('claude-sonnet-5-5');
    expect(settings.models.openai.standard).toBe('gpt-6.1-sol');
    expect(settings.models.bedrock.standard).toBe('global.anthropic.claude-sonnet-5-5');
    expect(settings.models.bedrock.deep).toBe('global.anthropic.claude-sonnet-5-5');
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
    const { calls, recorded, alerts } = setup();
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

  it('retries Anthropic once, then falls back to OpenAI (store: false), then to Bedrock', async () => {
    quiet();
    const overloaded = Object.assign(new Error('overloaded'), {
      name: 'AI_APICallError',
      statusCode: 529,
    });
    const { calls, recorded, sleeps } = setup({ behaviours: { anthropic: { error: overloaded } } });
    await expect(generate()).resolves.toMatchObject({ text: 'answer from openai' });
    expect(calls).toEqual([
      'anthropic:claude-sonnet-5-5:null',
      'anthropic:claude-sonnet-5-5:null',
      'openai:gpt-6.1-sol:{"store":false}',
    ]);
    expect(sleeps).toEqual([1250]);
    expect(recorded.map((row) => row.provider)).toEqual(['openai']);

    const failing = setup({
      behaviours: { anthropic: { error: overloaded }, openai: { error: new Error('auth') } },
    });
    await expect(generate()).resolves.toMatchObject({ text: 'answer from bedrock' });
    expect(providers(failing.calls)).toEqual(['anthropic', 'anthropic', 'openai', 'bedrock']);
  });

  it('answers on the retry when the first attempt hit a transient error', async () => {
    quiet();
    const { calls, recorded, sleeps } = setup({
      behaviours: { anthropic: [{ error: apiError(503) }, 'ok'] },
    });
    await expect(generate()).resolves.toMatchObject({ text: 'answer from anthropic' });
    expect(providers(calls)).toEqual(['anthropic', 'anthropic']);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(500);
    expect(sleeps[0]).toBeLessThanOrEqual(2000);
    expect(recorded).toHaveLength(1);
  });

  it('honours a short retry-after on 429 and fails over at once on a long one', async () => {
    quiet();
    const short = setup({
      behaviours: {
        anthropic: [{ error: apiError(429, { headers: { 'retry-after': '1' } }) }, 'ok'],
      },
    });
    await expect(generate()).resolves.toMatchObject({ text: 'answer from anthropic' });
    expect(short.sleeps).toEqual([1000]);

    const long = setup({
      behaviours: { anthropic: { error: apiError(429, { headers: { 'retry-after': '20' } }) } },
    });
    await expect(generate()).resolves.toMatchObject({ text: 'answer from openai' });
    expect(long.sleeps).toEqual([]);
    expect(providers(long.calls)).toEqual(['anthropic', 'openai']);

    const silent = setup({ behaviours: { anthropic: { error: apiError(429) } } });
    await expect(generate()).resolves.toMatchObject({ text: 'answer from openai' });
    expect(silent.sleeps).toEqual([]);
  });

  it('runs a real jittered wait between 0.5 and 2 s by default', async () => {
    quiet();
    vi.useFakeTimers();
    try {
      const { calls } = setup({
        behaviours: { anthropic: [{ error: apiError(500) }, 'ok'] },
        realSleep: true,
        random: 0,
      });
      const pending = generate();
      await vi.advanceTimersByTimeAsync(499);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ text: 'answer from anthropic' });
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [
      'a 400 bad request',
      apiError(400, { body: 'messages: text content blocks must be non-empty' }),
    ],
    ['a 2xx response the SDK could not use (an OpenAI refusal)', apiError(200)],
    ['a 422', apiError(422)],
  ])('surfaces %s without retry or failover', async (_label, error) => {
    const { calls, sleeps } = setup({ behaviours: { anthropic: { error } } });
    await expect(generate()).rejects.toBe(error);
    expect(providers(calls)).toEqual(['anthropic']);
    expect(sleeps).toEqual([]);
  });

  it('returns a refusal as is: never failed over, never escalated', async () => {
    const { calls } = setup({
      behaviours: { anthropic: { text: '', finish: 'content-filter' } },
    });
    const result = await generate(HAIKU_ON, 'ask-fathom', { tier: 'cheap' });
    expect(result.finishReason).toBe('content-filter');
    expect(models(calls)).toEqual(['anthropic:claude-haiku-5-5']);
  });

  it('fails over without retry on billing, auth and permission stops', async () => {
    quiet();
    for (const error of [
      apiError(402),
      apiError(401),
      apiError(403),
      apiError(404),
      apiError(400, { body: 'Your credit balance is too low to access the Anthropic API.' }),
    ]) {
      const { calls, sleeps } = setup({ behaviours: { anthropic: { error } } });
      await expect(generate()).resolves.toMatchObject({ text: 'answer from openai' });
      expect(providers(calls)).toEqual(['anthropic', 'openai']);
      expect(sleeps).toEqual([]);
    }
  });

  it('skips a provider with no configured key without calling it', async () => {
    const { calls } = setup({ keys: { anthropic: null } });
    await expect(generate()).resolves.toMatchObject({ text: 'answer from openai' });
    expect(providers(calls)).toEqual(['openai']);
    const env = {
      ...ENV,
      ANTHROPIC_API_KEY_SECRET_ID: undefined,
      OPENAI_API_KEY_SECRET_ID: undefined,
    };
    setup();
    await expect(generate(env)).resolves.toMatchObject({ text: 'answer from bedrock' });
  });

  it('skips a provider at its monthly cap and uses the next', async () => {
    const { calls } = setup({ spend: { anthropic: 190 } });
    await expect(generate()).resolves.toMatchObject({ text: 'answer from openai' });
    expect(providers(calls)).toEqual(['openai']);
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
    quiet();
    const { calls } = setup({ spendFails: true });
    await expect(generate()).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('is unavailable (PROVIDERS_FAILED) when every attempt fails', async () => {
    quiet();
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
    expect(forced.calls[0]).toMatch(/^bedrock:global\.anthropic\.claude-sonnet-5-5/);

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
    quiet();
    setup();
    __setRouterDependenciesForTests({
      now: () => new Date('2026-11-02T12:00:00Z'),
      storedSettings: async () => null,
      spend: async () => 0,
      apiKey: async () => 'k',
      model: ({ provider, modelId }) => fakeModel(provider, modelId, 'ok', [], []),
      record: async () => {
        throw new Error('ledger down');
      },
    });
    await expect(generate()).resolves.toMatchObject({ text: 'answer from anthropic' });
  });
});

describe('turn budget', () => {
  it('spends one model call per attempt, retries included, and stops with TURN_LIMIT', async () => {
    quiet();
    const turn = createTurnBudget({ maxModelCalls: 2 });
    const { calls } = setup({ behaviours: { anthropic: { error: apiError(529) } } });
    await expect(generate(ENV, 'ask-fathom', { turn })).rejects.toMatchObject({
      name: 'AIUnavailableError',
      reason: 'TURN_LIMIT',
    });
    expect(providers(calls)).toEqual(['anthropic', 'anthropic']);
    expect(turn.modelCalls).toBe(2);
  });

  it('does not contact a provider once the turn deadline has passed', async () => {
    const turn = createTurnBudget({ timeoutMs: 0 });
    const { calls } = setup();
    await expect(generate(ENV, 'ask-fathom', { turn })).rejects.toMatchObject({
      reason: 'TURN_LIMIT',
    });
    expect(calls).toEqual([]);
  });

  it('counts a successful call against the turn', async () => {
    const turn = createTurnBudget();
    setup();
    await generate(ENV, 'ask-fathom', { turn });
    expect(turn.modelCalls).toBe(1);
  });
});

describe('circuit breaker', () => {
  const failing = () => ({ anthropic: { error: new Error('connection lost') } as Behaviour });

  it('opens after 5 failures in 60 s, skips the provider, then lets one probe close it', async () => {
    quiet();
    const harness = setup({ behaviours: failing() });
    for (let index = 0; index < 5; index++) {
      await expect(generate()).resolves.toMatchObject({ text: 'answer from openai' });
    }
    expect(providers(harness.calls).filter((name) => name === 'anthropic')).toHaveLength(5);
    harness.calls.length = 0;
    await expect(generate()).resolves.toMatchObject({ text: 'answer from openai' });
    expect(providers(harness.calls)).toEqual(['openai']);

    // Half-open after 60 s: one probe; a success closes the circuit.
    harness.advance(CIRCUIT_OPEN_MS);
    harness.behaviours.anthropic = 'ok';
    harness.calls.length = 0;
    await expect(generate()).resolves.toMatchObject({ text: 'answer from anthropic' });
    await expect(generate()).resolves.toMatchObject({ text: 'answer from anthropic' });
    expect(providers(harness.calls)).toEqual(['anthropic', 'anthropic']);
  });

  it('reopens when the half-open probe fails', async () => {
    quiet();
    const harness = setup({ behaviours: failing() });
    for (let index = 0; index < 5; index++) await generate();
    harness.advance(CIRCUIT_OPEN_MS);
    harness.calls.length = 0;
    await generate();
    expect(providers(harness.calls)).toEqual(['anthropic', 'openai']);
    harness.calls.length = 0;
    await generate();
    expect(providers(harness.calls)).toEqual(['openai']);
    harness.advance(CIRCUIT_OPEN_MS - 1);
    harness.calls.length = 0;
    await generate();
    expect(providers(harness.calls)).toEqual(['openai']);
  });

  it('does not open on failures spread over more than 60 s', async () => {
    quiet();
    const harness = setup({ behaviours: failing() });
    for (let index = 0; index < 6; index++) {
      await generate();
      harness.advance(15_000);
    }
    expect(providers(harness.calls).filter((name) => name === 'anthropic')).toHaveLength(6);
  });

  it('keeps a provider out for 10 minutes after an auth or billing stop', async () => {
    quiet();
    const harness = setup({ behaviours: { anthropic: { error: apiError(402) } } });
    await generate();
    harness.calls.length = 0;
    harness.advance(CIRCUIT_LONG_OPEN_MS - 1);
    await generate();
    expect(providers(harness.calls)).toEqual(['openai']);
    harness.advance(1);
    harness.calls.length = 0;
    await generate();
    expect(providers(harness.calls)).toEqual(['anthropic', 'openai']);
  });

  it('reports CIRCUIT_OPEN when the only candidate is behind an open circuit', async () => {
    quiet();
    const harness = setup({
      behaviours: { anthropic: { error: apiError(401) } },
      stored: stored({ mode: 'ForceAnthropic', fallbackEnabled: false }),
    });
    await expect(generate()).rejects.toMatchObject({ reason: 'PROVIDERS_FAILED' });
    harness.calls.length = 0;
    await expect(generate()).rejects.toMatchObject({ reason: 'CIRCUIT_OPEN' });
    expect(harness.calls).toEqual([]);
    await expect(readRoutedAvailability(ENV)).resolves.toEqual({
      available: false,
      reason: 'CIRCUIT_OPEN',
    });
  });
});

describe('401 alert', () => {
  it('notifies SuperAdmins once per provider per hour', async () => {
    quiet();
    const harness = setup({ behaviours: { anthropic: { error: apiError(401) } } });
    await generate();
    // The circuit is open for 10 minutes; the next probe also fails within the hour.
    harness.advance(CIRCUIT_LONG_OPEN_MS);
    await generate();
    expect(providers(harness.calls).filter((name) => name === 'anthropic')).toHaveLength(2);
    expect(harness.authAlerts).toEqual([{ provider: 'anthropic', at: '2026-11-02T12:00:00.000Z' }]);
    harness.advance(60 * 60 * 1000);
    await generate();
    expect(harness.authAlerts).toHaveLength(2);
    expect(harness.authAlerts[1].provider).toBe('anthropic');
  });

  it('does not alert on other failures', async () => {
    quiet();
    const harness = setup({ behaviours: { anthropic: { error: apiError(403) } } });
    await generate();
    expect(harness.authAlerts).toEqual([]);
  });
});

describe('workloads', () => {
  it('keeps the weekly owner summary on the Anthropic deep model and never fails over', async () => {
    quiet();
    const ok = setup({ deepStrategy: false });
    await expect(generate(ENV, 'weekly-owner-summary')).resolves.toMatchObject({
      text: 'answer from anthropic',
    });
    expect(models(ok.calls)).toEqual(['anthropic:claude-opus-5-5']);
    expect(ok.optInReads).toEqual([]);
    expect(ok.recorded[0]).toMatchObject({ tier: 'deep', model: 'claude-opus-5-5' });

    const failing = setup({ behaviours: { anthropic: { error: apiError(529) } } });
    await expect(generate(ENV, 'weekly-owner-summary')).rejects.toMatchObject({
      reason: 'PROVIDERS_FAILED',
    });
    expect(providers(failing.calls)).toEqual(['anthropic', 'anthropic']);

    const forcedElsewhere = setup({ stored: stored({ mode: 'ForceOpenAI' }) });
    await generate(ENV, 'weekly-owner-summary');
    expect(models(forcedElsewhere.calls)).toEqual(['anthropic:claude-opus-5-5']);

    const disabled = setup({ stored: stored({ mode: 'Disabled' }) });
    await expect(generate(ENV, 'weekly-owner-summary')).rejects.toMatchObject({
      reason: 'DISABLED',
    });
    expect(disabled.calls).toEqual([]);
  });

  it('runs deep strategy on the deep model only for an opted-in organization', async () => {
    const optedIn = setup({ deepStrategy: true });
    await generate(ENV, 'periodic-owner-reports');
    expect(models(optedIn.calls)).toEqual(['anthropic:claude-opus-5-5']);
    expect(optedIn.optInReads).toEqual(['org-1']);

    const notOptedIn = setup({ deepStrategy: false });
    await generate(ENV, 'periodic-owner-reports');
    expect(models(notOptedIn.calls)).toEqual(['anthropic:claude-sonnet-5-5']);
    expect(notOptedIn.recorded[0]).toMatchObject({ tier: 'standard' });
  });

  it('treats an unreadable opt-in as not opted in, and caches a read for 30 s', async () => {
    quiet();
    const broken = setup({ deepStrategy: 'fails' });
    await generate(ENV, 'periodic-owner-reports');
    expect(models(broken.calls)).toEqual(['anthropic:claude-sonnet-5-5']);

    const cached = setup({ deepStrategy: true });
    await generate(ENV, 'periodic-owner-reports');
    await generate(ENV, 'periodic-owner-reports');
    expect(cached.optInReads).toHaveLength(1);
    cached.advance(30_000);
    await generate(ENV, 'periodic-owner-reports');
    expect(cached.optInReads).toHaveLength(2);
  });

  it('keeps a quick lookup on the standard model while AF_HAIKU_LOOKUPS is off', async () => {
    const { calls, recorded } = setup({ behaviours: { anthropic: { text: '' } } });
    await generate(ENV, 'ask-fathom', { tier: 'cheap' });
    expect(models(calls)).toEqual(['anthropic:claude-sonnet-5-5']);
    expect(recorded[0]).toMatchObject({ tier: 'standard' });
  });

  it('uses the small model with AF_HAIKU_LOOKUPS=true and keeps a good answer', async () => {
    const { calls, recorded } = setup();
    const result = await generate(HAIKU_ON, 'ask-fathom', { tier: 'cheap' });
    expect(result.text).toBe('answer from anthropic');
    expect(models(calls)).toEqual(['anthropic:claude-haiku-5-5']);
    expect(recorded[0]).toMatchObject({ tier: 'cheap', model: 'claude-haiku-5-5' });
  });

  it('resends an empty small-model answer once on the standard model', async () => {
    const { calls, recorded } = setup({ behaviours: { anthropic: [{ text: '' }, 'ok'] } });
    const result = await generate(HAIKU_ON, 'ask-fathom', { tier: 'cheap' });
    expect(result.text).toBe('answer from anthropic');
    expect(models(calls)).toEqual(['anthropic:claude-haiku-5-5', 'anthropic:claude-sonnet-5-5']);
    expect(recorded.map((row) => row.tier)).toEqual(['cheap', 'standard']);
  });

  it('resends a cut-off small-model answer once on the standard model', async () => {
    const { calls } = setup({
      behaviours: { anthropic: [{ text: 'The top sel', finish: 'length' }, 'ok'] },
    });
    await generate(HAIKU_ON, 'ask-fathom', { tier: 'cheap' });
    expect(models(calls)).toEqual(['anthropic:claude-haiku-5-5', 'anthropic:claude-sonnet-5-5']);
  });

  it('does not resend a small-model answer that is only a tool call', async () => {
    const { calls } = setup({
      behaviours: { anthropic: { text: '', toolCall: true, finish: 'tool-calls' } },
    });
    await generateText({
      model: createAIModel(HAIKU_ON, { feature: 'ask-fathom', tier: 'cheap' }).model,
      prompt: 'hello',
      maxRetries: 0,
    }).catch(() => undefined);
    expect(models(calls)).toEqual(['anthropic:claude-haiku-5-5']);
  });

  it('keeps the small-model answer when the escalation cannot run', async () => {
    quiet();
    const turn = createTurnBudget({ maxModelCalls: 1 });
    const { calls } = setup({ behaviours: { anthropic: { text: 'Partial', finish: 'length' } } });
    const result = await generate(HAIKU_ON, 'ask-fathom', { tier: 'cheap', turn });
    expect(result.text).toBe('Partial');
    expect(models(calls)).toEqual(['anthropic:claude-haiku-5-5']);
  });

  it('buffers a small-model stream and resends an empty one on the standard model', async () => {
    const { calls, recorded } = setup({ behaviours: { anthropic: [{ text: '' }, 'ok'] } });
    const result = streamText({
      model: createAIModel(HAIKU_ON, {
        feature: 'ask-fathom',
        tier: 'cheap',
        organizationId: 'org-1',
      }).model,
      prompt: 'hello',
      maxRetries: 0,
    });
    await expect(result.text).resolves.toBe('streamed from anthropic');
    expect(models(calls)).toEqual(['anthropic:claude-haiku-5-5', 'anthropic:claude-sonnet-5-5']);
    expect(recorded.map((row) => row.tier)).toEqual(['cheap', 'standard']);
  });

  it('replays a good small-model stream without escalation', async () => {
    const { calls, recorded } = setup();
    const result = streamText({
      model: createAIModel(HAIKU_ON, { feature: 'ask-fathom', tier: 'cheap' }).model,
      prompt: 'hello',
      maxRetries: 0,
    });
    await expect(result.text).resolves.toBe('streamed from anthropic');
    expect(models(calls)).toEqual(['anthropic:claude-haiku-5-5']);
    expect(recorded).toHaveLength(1);
  });

  it('never escalates a refused stream', async () => {
    const { calls } = setup({ behaviours: { anthropic: { text: '', finish: 'content-filter' } } });
    const result = streamText({
      model: createAIModel(HAIKU_ON, { feature: 'ask-fathom', tier: 'cheap' }).model,
      prompt: 'hello',
      maxRetries: 0,
    });
    await expect(result.finishReason).resolves.toBe('content-filter');
    expect(models(calls)).toEqual(['anthropic:claude-haiku-5-5']);
  });
});

describe('personal data and Bedrock', () => {
  const PROMPT = 'Customer 0300-1234567 (ali@example.com) spent PKR 1,250,000 on 2026-11-01.';

  const promptText = (call: Call) => JSON.stringify(call.options.prompt);

  it('masks personal data in the prompt of Bedrock attempts only, keeping the figures', async () => {
    quiet();
    const { log } = setup({
      behaviours: { anthropic: { error: new Error('down') }, openai: { error: new Error('down') } },
    });
    await expect(generate(ENV, 'ask-fathom', { prompt: PROMPT })).resolves.toMatchObject({
      text: 'answer from bedrock',
    });
    const [anthropic, openai, bedrock] = log;
    expect(promptText(anthropic)).toContain('0300-1234567');
    expect(promptText(openai)).toContain('ali@example.com');
    expect(promptText(bedrock)).not.toContain('0300-1234567');
    expect(promptText(bedrock)).not.toContain('ali@example.com');
    expect(promptText(bedrock)).toContain(
      'Customer [phone] ([email]) spent PKR 1,250,000 on 2026-11-01.'
    );
  });

  it('masks a forced Bedrock call too', async () => {
    const { log } = setup({ stored: stored({ mode: 'ForceBedrock' }) });
    await generate(ENV, 'ask-fathom', { prompt: PROMPT });
    expect(log[0].provider).toBe('bedrock');
    expect(promptText(log[0])).toContain('[phone]');
  });
});

describe('streaming', () => {
  it('fails over before the stream starts and meters the finished stream', async () => {
    quiet();
    const { calls, recorded } = setup({ behaviours: { anthropic: { error: new Error('503') } } });
    const result = streamText({
      model: createAIModel(ENV, { feature: 'ask-fathom', organizationId: 'org-1' }).model,
      prompt: 'hello',
      maxRetries: 0,
    });
    await expect(result.text).resolves.toBe('streamed from openai');
    expect(providers(calls)).toEqual(['anthropic', 'openai']);
    expect(recorded).toEqual([
      expect.objectContaining({ provider: 'openai', inputTokens: 200, outputTokens: 100 }),
    ]);
  });
});

describe('unavailable errors', () => {
  it('exposes a stable reason for callers', () => {
    expect(new AIUnavailableError('CAPPED').reason).toBe('CAPPED');
    expect(new AIUnavailableError('TURN_LIMIT').reason).toBe('TURN_LIMIT');
    expect(new AIUnavailableError('CIRCUIT_OPEN').reason).toBe('CIRCUIT_OPEN');
  });
});
