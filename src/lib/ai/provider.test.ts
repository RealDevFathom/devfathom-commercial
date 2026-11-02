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
  getModelForTier,
  readAIAvailability,
  readAIConfig,
} from './provider';
import { generateGrowthRecommendations, type GrowthInput } from './growth-recommendations';
const inert = {
  AI_MODEL: 'inert-model',
  AZURE_OPENAI_RESOURCE_NAME: 'inert-resource',
  GROQ_API_KEY: 'inert-test-key',
  GOOGLE_GENERATIVE_AI_API_KEY: 'inert-test-key',
  GOOGLE_VERTEX_API_KEY: 'inert-test-key',
  ANTHROPIC_API_KEY: 'inert-test-key',
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
  it.each(['anthropic', 'bedrock'] as const)('selects the %s adapter', (provider) => {
    expect(createAIModel({ ...inert, AI_PROVIDER: provider })).toMatchObject({
      provider,
      modelId: 'inert-model',
    });
    expect(sdk[provider]).toHaveBeenCalledOnce();
    expect(sdk.select).toHaveBeenCalledWith('inert-model');
  });
  it('reports Anthropic without an API key as not configured', () => {
    const env = { AI_PROVIDER: 'anthropic', AI_MODEL: 'inert-model' };
    expect(readAIAvailability(env)).toEqual({ available: false, reason: 'NOT_CONFIGURED' });
    expect(() => readAIConfig(env)).toThrow(AIUnavailableError);
    expect(sdk.anthropic).not.toHaveBeenCalled();
  });
  it('uses the AWS credential chain and never forwards static keys', () => {
    createAIModel({
      AI_PROVIDER: 'bedrock',
      AI_MODEL: 'inert-model',
      AWS_REGION: 'us-west-2',
      AWS_ACCESS_KEY_ID: 'must-not-forward',
      AWS_SECRET_ACCESS_KEY: 'must-not-forward',
    });
    expect(sdk.awsCredentialChain).toHaveBeenCalledOnce();
    expect(sdk.bedrock).toHaveBeenCalledWith({
      region: 'us-west-2',
      credentialProvider: sdk.credentialProvider,
    });
    expect(sdk.bedrock.mock.calls[0]?.[0]).not.toHaveProperty('accessKeyId');
    expect(sdk.bedrock.mock.calls[0]?.[0]).not.toHaveProperty('secretAccessKey');
  });
  it('constructs tier models with defaults, overrides, and the Bedrock region precedence', () => {
    getModelForTier('anthropic', 'cheap', undefined, {
      ANTHROPIC_API_KEY: 'inert-test-key',
    });
    expect(sdk.select).toHaveBeenLastCalledWith('claude-haiku-4-5-20251001');

    getModelForTier(
      'bedrock',
      'deep',
      { deep: 'tenant-deep-model' },
      {
        AWS_REGION: 'ignored-region',
        AI_BEDROCK_REGION: 'ap-southeast-2',
      }
    );
    expect(sdk.select).toHaveBeenLastCalledWith('tenant-deep-model');
    expect(sdk.bedrock).toHaveBeenLastCalledWith({
      region: 'ap-southeast-2',
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
