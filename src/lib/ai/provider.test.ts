import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => {
  const select = vi.fn(() => ({ specificationVersion: 'v3' }));
  return {
    select,
    azure: vi.fn(() => select),
    google: vi.fn(() => select),
    vertex: vi.fn(() => select),
    groq: vi.fn(() => select),
    anthropic: vi.fn(() => select),
    bedrock: vi.fn<(options: unknown) => typeof select>(() => select),
    defaultCredentials: vi.fn(),
    awsCredentials: vi.fn(async () => ({
      accessKeyId: 'inert-role-key',
      secretAccessKey: 'inert-role-secret',
      sessionToken: 'inert-role-session',
    })),
    credential: vi.fn(function () {}),
    token: vi.fn(),
    generate: vi.fn(),
    stream: vi.fn(),
    fetch: vi.fn(),
  };
});
vi.mock('@ai-sdk/azure', () => ({ createAzure: sdk.azure }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: sdk.anthropic }));
vi.mock('@ai-sdk/amazon-bedrock', () => ({ createAmazonBedrock: sdk.bedrock }));
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: sdk.google }));
vi.mock('@ai-sdk/google-vertex', () => ({ createVertex: sdk.vertex }));
vi.mock('@ai-sdk/groq', () => ({ createGroq: sdk.groq }));
vi.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: sdk.defaultCredentials,
}));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: sdk.credential,
  getBearerTokenProvider: sdk.token,
}));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: sdk.generate,
  streamText: sdk.stream,
}));
import { AIUnavailableError, createAIModel, readAIAvailability, readAIConfig } from './provider';
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
  sdk.defaultCredentials.mockReturnValue(sdk.awsCredentials);
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
  it.each(['anthropic', 'bedrock'] as const)('constructs the seeded %s model', (provider) => {
    const env = {
      AI_PROVIDER: provider,
      AI_MODEL_CLASS: 'deep',
      ANTHROPIC_API_KEY: 'inert-key',
      AWS_REGION: 'us-east-1',
    };
    const selection = createAIModel(env);
    expect(selection).toMatchObject({
      provider,
      modelId:
        provider === 'anthropic'
          ? 'claude-opus-4-1-20250805'
          : 'us.anthropic.claude-opus-4-1-20250805-v1:0',
    });
    expect(sdk[provider]).toHaveBeenCalledWith(
      provider === 'anthropic'
        ? { apiKey: 'inert-key' }
        : { region: 'us-east-1', credentialProvider: sdk.awsCredentials }
    );
    expect(sdk.fetch).not.toHaveBeenCalled();
  });
  it('passes the lazy AWS credential chain, including role session tokens, to Bedrock', async () => {
    createAIModel({ AI_PROVIDER: 'bedrock', AWS_REGION: 'us-east-1' });
    expect(sdk.defaultCredentials).toHaveBeenCalledExactlyOnceWith();
    expect(sdk.awsCredentials).not.toHaveBeenCalled();
    const options = sdk.bedrock.mock.calls[0][0] as unknown as {
      credentialProvider: typeof sdk.awsCredentials;
    };
    await expect(options.credentialProvider()).resolves.toEqual({
      accessKeyId: 'inert-role-key',
      secretAccessKey: 'inert-role-secret',
      sessionToken: 'inert-role-session',
    });
    expect(sdk.fetch).not.toHaveBeenCalled();
  });
  it('validates Claude configuration and preserves exact model overrides', () => {
    expect(() => readAIConfig({ AI_PROVIDER: 'anthropic' })).toThrow('ANTHROPIC_API_KEY');
    expect(() => readAIConfig({ AI_PROVIDER: 'bedrock' })).toThrow('AWS_REGION');
    expect(() => readAIConfig({ AI_PROVIDER: 'bedrock', AI_MODEL_CLASS: 'typo' })).toThrow(
      'AI_MODEL_CLASS'
    );
    expect(
      readAIConfig({
        AI_PROVIDER: 'bedrock',
        AI_MODEL: 'anthropic-model',
        AI_BEDROCK_MODEL: 'bedrock-model',
        AWS_REGION: 'us-east-1',
      })
    ).toMatchObject({ model: 'bedrock-model' });
  });
});
