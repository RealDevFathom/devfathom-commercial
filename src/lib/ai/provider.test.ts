import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => {
  const select = vi.fn(() => ({ specificationVersion: 'v3' }));
  const credentialProvider = vi.fn();
  return {
    select,
    azure: vi.fn(() => select),
    google: vi.fn(() => select),
    vertex: vi.fn(() => select),
    groq: vi.fn(() => select),
    anthropic: vi.fn(() => select),
    openai: vi.fn(() => select),
    bedrock: vi.fn(() => select),
    awsCredentialChain: vi.fn(() => credentialProvider),
    credentialProvider,
    credential: vi.fn(function () {}),
    token: vi.fn(),
    generate: vi.fn(),
    stream: vi.fn(),
    fetch: vi.fn(),
  };
});
vi.mock('@ai-sdk/amazon-bedrock', () => ({ createAmazonBedrock: sdk.bedrock }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: sdk.anthropic }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: sdk.openai }));
vi.mock('@ai-sdk/azure', () => ({ createAzure: sdk.azure }));
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: sdk.google }));
vi.mock('@ai-sdk/google-vertex', () => ({ createVertex: sdk.vertex }));
vi.mock('@ai-sdk/groq', () => ({ createGroq: sdk.groq }));
vi.mock('@aws-sdk/credential-providers', () => ({ fromNodeProviderChain: sdk.awsCredentialChain }));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: sdk.credential,
  getBearerTokenProvider: sdk.token,
}));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: sdk.generate,
  streamText: sdk.stream,
}));
import {
  AIUnavailableError,
  createAIModel,
  configuredRoutedProviders,
  createTieredModel,
  readAIAvailability,
  readAIConfig,
  readAIProviderReadiness,
  readAISelector,
} from './provider';
import { generateGrowthRecommendations, type GrowthInput } from './growth-recommendations';
const inert = {
  AI_MODEL: 'inert-model',
  AZURE_OPENAI_RESOURCE_NAME: 'inert-resource',
  GROQ_API_KEY: 'inert-test-key',
  GOOGLE_GENERATIVE_AI_API_KEY: 'inert-test-key',
  GOOGLE_VERTEX_API_KEY: 'inert-test-key',
};
const input: GrowthInput = {
  vertical: 'RESTAURANT',
  currency: 'PKR',
  current: { from: '2026-09-01T00:00:00Z', cutoff: '2026-10-01T00:00:00Z' },
  comparison: { from: '2026-08-01T00:00:00Z', cutoff: '2026-09-01T00:00:00Z' },
  facts: [
    {
      ref: 'e1',
      metric: 'receipt_count',
      value: '20',
      period: 'CURRENT',
      cohortSize: 10,
      coverage: 'COMPLETE',
      freshAt: '2026-10-01T00:00:00Z',
    },
  ],
  actions: [{ ref: 'a1', kind: 'RETAIL_REVIEW' }],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', sdk.fetch);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('shared provider gate with real factory boundary', () => {
  it.each([undefined, '', '  ', 'disabled', ' DISABLED ', 'unknown'])(
    'blocks %s without SDK/discovery/selector/network',
    async (provider) => {
      const env = { ...inert, AI_PROVIDER: provider };
      expect(readAIAvailability(env)).toEqual({
        available: false,
        reason: provider === 'unknown' ? 'INVALID_PROVIDER' : 'DISABLED',
      });
      expect(() => readAIConfig(env)).toThrow(AIUnavailableError);
      expect(() => createAIModel(env)).toThrow('AI is currently unavailable.');
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      for (const facts of [input.facts, []])
        expect(await generateGrowthRecommendations({ ...input, facts })).toMatchObject({
          status: 'UNAVAILABLE',
          failureCode: 'CONFIGURATION',
          output: null,
        });
      for (const spy of Object.values(sdk)) expect(spy).not.toHaveBeenCalled();
    }
  );
  it('does not read credentials or model in the pure gate or disabled factory', () => {
    const env = {
      AI_PROVIDER: 'disabled',
      get AI_MODEL(): string {
        throw new Error('must not read');
      },
      get GROQ_API_KEY(): string {
        throw new Error('must not read');
      },
    };
    expect(readAIAvailability(env).available).toBe(false);
    expect(() => createAIModel(env)).toThrow(AIUnavailableError);
  });
  it.each(['azure', 'groq', 'google', 'vertex'] as const)(
    'preserves configured %s selection via fake SDK',
    (provider) => {
      expect(createAIModel({ ...inert, AI_PROVIDER: ` ${provider.toUpperCase()} ` })).toMatchObject(
        { provider, modelId: 'inert-model' }
      );
      expect(sdk[provider]).toHaveBeenCalledOnce();
      expect(sdk.select).toHaveBeenCalledWith('inert-model');
      expect(sdk.credential).toHaveBeenCalledTimes(provider === 'azure' ? 1 : 0);
      expect(sdk.fetch).not.toHaveBeenCalled();
    }
  );
  it.each(['anthropic', 'openai', 'bedrock'] as const)(
    'routes AI_PROVIDER=%s through the chain without building an SDK at selection time',
    (provider) => {
      const env = {
        AI_PROVIDER: provider,
        NODE_ENV: 'development',
        ANTHROPIC_API_KEY: 'inert-test-key',
        OPENAI_API_KEY: 'inert-test-key',
        BEDROCK_REGION: 'us-east-1',
      };
      expect(createAIModel(env)).toMatchObject({ provider: 'auto', modelId: 'auto:standard' });
      expect(readAIConfig(env)).toMatchObject({ provider: 'auto', preferred: provider });
      expect(configuredRoutedProviders(env)[0]).toBe(provider);
      for (const spy of [sdk.anthropic, sdk.openai, sdk.bedrock])
        expect(spy).not.toHaveBeenCalled();
    }
  );
  it.each([undefined, '', '   '])(
    'keeps AI off when AI_PROVIDER is %j, even with providers configured',
    (selector) => {
      const env = {
        AI_PROVIDER: selector,
        ANTHROPIC_API_KEY_SECRET_ID: 'devfathom/staging/anthropic-api-key',
        OPENAI_API_KEY_SECRET_ID: 'devfathom/staging/openai-api-key',
        BEDROCK_REGION: 'ap-southeast-1',
        ANTHROPIC_API_KEY: 'local-key',
      };
      expect(readAISelector(env)).toEqual({ kind: 'disabled' });
      expect(readAIAvailability(env)).toEqual({ available: false, reason: 'DISABLED' });
      expect(readAIProviderReadiness(env)).toMatchObject({ ready: false, reason: 'DISABLED' });
      expect(() => createAIModel(env, { feature: 'ask-fathom' })).toThrow(AIUnavailableError);
    }
  );
  it('uses the routed chain only when AI_PROVIDER is auto', () => {
    const env = {
      AI_PROVIDER: 'auto',
      OPENAI_API_KEY_SECRET_ID: 'devfathom/staging/openai-api-key',
    };
    expect(readAISelector(env)).toEqual({ kind: 'routed', preferred: null });
    expect(readAIAvailability(env)).toEqual({ available: true, provider: 'auto' });
    expect(createAIModel(env, { feature: 'ask-fathom' })).toMatchObject({
      modelId: 'auto:standard',
    });
  });
  it('ignores plain API keys in production and requires the Secrets Manager id', () => {
    const production = {
      AI_PROVIDER: 'anthropic',
      NODE_ENV: 'production',
      ANTHROPIC_API_KEY: 'must-not-be-used',
      OPENAI_API_KEY: 'must-not-be-used',
    };
    expect(readAIAvailability(production)).toEqual({ available: false, reason: 'NOT_CONFIGURED' });
    expect(() => readAIConfig(production)).toThrow(AIUnavailableError);
    expect(
      readAIAvailability({
        ...production,
        ANTHROPIC_API_KEY_SECRET_ID: 'devfathom/staging/anthropic-api-key',
      })
    ).toEqual({ available: true, provider: 'auto' });
  });
  it('orders the chain by AI_PROVIDER_ORDER and never includes Azure', () => {
    const env = {
      ...inert,
      AI_PROVIDER_ORDER: 'bedrock, azure, openai, anthropic, openai',
      ANTHROPIC_API_KEY_SECRET_ID: 'a',
      OPENAI_API_KEY_SECRET_ID: 'o',
      BEDROCK_REGION: 'us-east-1',
    };
    expect(configuredRoutedProviders(env)).toEqual(['bedrock', 'openai', 'anthropic']);
    expect(configuredRoutedProviders({ ...env, AI_PROVIDER: 'anthropic' })).toEqual([
      'anthropic',
      'bedrock',
      'openai',
    ]);
    expect(createAIModel({ ...inert, AI_PROVIDER: 'azure' })).toMatchObject({ provider: 'azure' });
  });
  it('builds Anthropic and OpenAI models only with a resolved key', () => {
    createTieredModel({
      provider: 'anthropic',
      modelId: 'claude-haiku-5-5',
      apiKey: 'resolved-key',
    });
    expect(sdk.anthropic).toHaveBeenCalledWith({ apiKey: 'resolved-key' });
    expect(sdk.select).toHaveBeenLastCalledWith('claude-haiku-5-5');
    createTieredModel({ provider: 'openai', modelId: 'gpt-5.4-mini', apiKey: 'resolved-key' });
    expect(sdk.openai).toHaveBeenCalledWith({ apiKey: 'resolved-key' });
    expect(sdk.select).toHaveBeenLastCalledWith('gpt-5.4-mini');
    expect(() => createTieredModel({ provider: 'openai', modelId: 'm', apiKey: null })).toThrow(
      AIUnavailableError
    );
  });
  it('builds Bedrock with the AWS credential chain in us-east-1 and never forwards static keys', () => {
    createTieredModel({
      provider: 'bedrock',
      modelId: 'us.anthropic.claude-sonnet-5-5',
      env: { AWS_ACCESS_KEY_ID: 'must-not-forward', AWS_SECRET_ACCESS_KEY: 'must-not-forward' },
    });
    expect(sdk.awsCredentialChain).toHaveBeenCalledOnce();
    expect(sdk.bedrock).toHaveBeenCalledWith({
      region: 'us-east-1',
      credentialProvider: sdk.credentialProvider,
    });
    const [bedrockOptions] = sdk.bedrock.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(bedrockOptions).not.toHaveProperty('accessKeyId');
    expect(bedrockOptions).not.toHaveProperty('secretAccessKey');
    createTieredModel({
      provider: 'bedrock',
      modelId: 'm',
      env: { AI_BEDROCK_REGION: 'us-west-2', BEDROCK_REGION: 'us-east-2' },
    });
    expect(sdk.bedrock).toHaveBeenLastCalledWith({
      region: 'us-east-2',
      credentialProvider: sdk.credentialProvider,
    });
  });
  it('preserves vertex project/location and missing credential validation', () => {
    createAIModel({
      AI_PROVIDER: 'vertex',
      AI_MODEL: 'inert-model',
      GOOGLE_VERTEX_PROJECT: 'inert-project',
      GOOGLE_VERTEX_LOCATION: 'inert-location',
    });
    expect(sdk.vertex).toHaveBeenCalledWith({
      project: 'inert-project',
      location: 'inert-location',
    });
    expect(() => readAIConfig({ AI_PROVIDER: 'groq', AI_MODEL: 'model' })).toThrow(
      '[ai:groq] GROQ_API_KEY is required.'
    );
  });
});

describe('provider readiness (DEV-583)', () => {
  it.each([
    [{}, 'DISABLED', null, ['AI_PROVIDER'], []],
    [{ AI_PROVIDER: ' disabled ' }, 'DISABLED', null, ['AI_PROVIDER'], []],
    [{ AI_PROVIDER: 'not-a-provider' }, 'INVALID_PROVIDER', null, [], ['AI_PROVIDER']],
    [{ AI_PROVIDER: 'groq' }, 'MISSING_CONFIG', 'groq', ['AI_MODEL', 'GROQ_API_KEY'], []],
    [{ AI_PROVIDER: 'groq', AI_MODEL: 'm' }, 'MISSING_CONFIG', 'groq', ['GROQ_API_KEY'], []],
    [{ AI_PROVIDER: 'groq', GROQ_API_KEY: 'k' }, 'MISSING_CONFIG', 'groq', ['AI_MODEL'], []],
    [
      { AI_PROVIDER: 'google', AI_MODEL: 'm', GOOGLE_GENERATIVE_AI_API_KEY: '  ' },
      'MISSING_CONFIG',
      'google',
      ['GOOGLE_GENERATIVE_AI_API_KEY'],
      [],
    ],
    [
      { AI_PROVIDER: 'azure', AI_MODEL: 'm' },
      'MISSING_CONFIG',
      'azure',
      ['AZURE_OPENAI_RESOURCE_NAME'],
      [],
    ],
    [
      { AI_PROVIDER: 'vertex', AI_MODEL: 'm' },
      'MISSING_CONFIG',
      'vertex',
      ['GOOGLE_VERTEX_PROJECT', 'GOOGLE_VERTEX_LOCATION'],
      [],
    ],
    [
      { AI_PROVIDER: 'vertex', AI_MODEL: 'm', GOOGLE_VERTEX_PROJECT: 'p' },
      'MISSING_CONFIG',
      'vertex',
      ['GOOGLE_VERTEX_LOCATION'],
      [],
    ],
    ...['${AI_MODEL}', '<model>', 'two words', '-model', 'x'.repeat(300)].map(
      (AI_MODEL) =>
        [
          { AI_PROVIDER: 'groq', AI_MODEL, GROQ_API_KEY: 'k' },
          'INVALID_MODEL',
          'groq',
          [],
          ['AI_MODEL'],
        ] as const
    ),
  ] as const)('reports %j as %s', (env, reason, provider, missing, invalid) => {
    expect(readAIProviderReadiness(env)).toEqual({
      ready: false,
      reason,
      provider,
      missing,
      invalid,
    });
    expect(() => createAIModel(env)).toThrow();
    for (const spy of Object.values(sdk)) expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    [{ AI_PROVIDER: 'azure', AI_MODEL: 'gpt-4o', AZURE_OPENAI_RESOURCE_NAME: 'r' }, 'azure'],
    [{ AI_PROVIDER: 'GROQ', AI_MODEL: 'openai/gpt-oss-120b', GROQ_API_KEY: 'k' }, 'groq'],
    [
      { AI_PROVIDER: 'google', AI_MODEL: 'gemini-2.5-flash', GOOGLE_GENERATIVE_AI_API_KEY: 'k' },
      'google',
    ],
    [
      { AI_PROVIDER: 'vertex', AI_MODEL: 'claude-x@20250929', GOOGLE_VERTEX_API_KEY: 'k' },
      'vertex',
    ],
    [
      {
        AI_PROVIDER: 'vertex',
        AI_MODEL: 'gemini-2.5-pro',
        GOOGLE_VERTEX_PROJECT: 'p',
        GOOGLE_VERTEX_LOCATION: 'l',
      },
      'vertex',
    ],
  ] as const)('reports %j ready for %s, matching the model factory', (env, provider) => {
    expect(readAIProviderReadiness(env)).toEqual({
      ready: true,
      provider,
      modelId: env.AI_MODEL,
    });
    expect(createAIModel(env)).toMatchObject({ provider, modelId: env.AI_MODEL });
  });

  it('names settings without returning any configured value', () => {
    const readiness = readAIProviderReadiness({
      AI_PROVIDER: 'vertex',
      AI_MODEL: 'secret-model-name with space',
      GOOGLE_VERTEX_PROJECT: 'secret-project',
    });
    expect(JSON.stringify(readiness)).not.toMatch(/secret/);
  });

  it('keeps the factory error naming the first missing or invalid setting', () => {
    expect(() => readAIConfig({ AI_PROVIDER: 'groq', GROQ_API_KEY: 'k' })).toThrow(
      '[ai:groq] AI_MODEL is required.'
    );
    expect(() =>
      readAIConfig({ AI_PROVIDER: 'groq', AI_MODEL: '${AI_MODEL}', GROQ_API_KEY: 'k' })
    ).toThrow('[ai:groq] AI_MODEL is invalid.');
  });
});
