import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => {
  const select = vi.fn(() => ({ specificationVersion: 'v3' }));
  return {
    select,
    bedrock: vi.fn(() => select),
    azure: vi.fn(() => select),
    google: vi.fn(() => select),
    vertex: vi.fn(() => select),
    groq: vi.fn(() => select),
    credential: vi.fn(function () {}),
    token: vi.fn(),
    generate: vi.fn(),
    stream: vi.fn(),
    fetch: vi.fn(),
  };
});
vi.mock('@ai-sdk/amazon-bedrock', () => ({ createAmazonBedrock: sdk.bedrock }));
vi.mock('@ai-sdk/azure', () => ({ createAzure: sdk.azure }));
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: sdk.google }));
vi.mock('@ai-sdk/google-vertex', () => ({ createVertex: sdk.vertex }));
vi.mock('@ai-sdk/groq', () => ({ createGroq: sdk.groq }));
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
  createRoutedAIModel,
  readAIAvailability,
  readAIConfig,
} from './provider';
import { DEFAULT_AI_MODELS } from './model-defaults';
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

// Supported inference profiles, rather than base IDs that reject on-demand calls.
describe('budget-routed Bedrock factory', () => {
  it.each([
    ['cheap', 'global.anthropic.claude-haiku-4-5-20251001-v1:0'],
    ['standard', 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'],
    ['deep', 'us.anthropic.claude-opus-4-1-20250805-v1:0'],
  ] as const)('passes the supported %s profile to the SDK', (tier, model) => {
    const selection = createRoutedAIModel(
      { provider: 'bedrock', model: DEFAULT_AI_MODELS.bedrock[tier] },
      { AWS_REGION: 'us-west-2' }
    );
    expect(sdk.select).toHaveBeenCalledExactlyOnceWith(model);
    expect(selection).toMatchObject({ provider: 'bedrock', modelId: model });
    expect(sdk.fetch).not.toHaveBeenCalled();
  });
});
