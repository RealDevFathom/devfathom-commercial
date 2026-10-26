import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createVertex } from '@ai-sdk/google-vertex';
import { createGroq } from '@ai-sdk/groq';
import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import type { LanguageModel } from 'ai';
import type { RoutedAIProvider } from './model-defaults';

type Env = Record<string, string | undefined>;
export type AIProviderName = 'azure' | 'groq' | 'google' | 'vertex';

export type AIAvailability =
  | { available: true; provider: AIProviderName }
  | { available: false; reason: 'DISABLED' | 'INVALID_PROVIDER' };

/** Pure selector gate; available does not assert credentials or provider health. */
export function readAIAvailability(env: Env = process.env): AIAvailability {
  const provider = env.AI_PROVIDER?.trim().toLowerCase();
  if (!provider || provider === 'disabled') return { available: false, reason: 'DISABLED' };
  switch (provider) {
    case 'azure':
    case 'groq':
    case 'google':
    case 'vertex':
      return { available: true, provider };
    default:
      return { available: false, reason: 'INVALID_PROVIDER' };
  }
}

export class AIUnavailableError extends Error {
  constructor(readonly reason: 'DISABLED' | 'INVALID_PROVIDER') {
    super('AI is currently unavailable.');
    this.name = 'AIUnavailableError';
  }
}

export type AIConfig =
  | { provider: 'azure'; model: string; resourceName: string }
  | { provider: 'groq'; model: string; apiKey: string }
  | { provider: 'google'; model: string; apiKey: string }
  | {
      provider: 'vertex';
      model: string;
      apiKey?: string;
      project?: string;
      location?: string;
    };

export type AIModelSelection = {
  model: LanguageModel;
  provider: AIProviderName | RoutedAIProvider;
  modelId: string;
  providerOptions?: Record<string, Record<string, boolean>>;
};

function required(env: Env, name: string, provider: AIProviderName | RoutedAIProvider): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`[ai:${provider}] ${name} is required.`);
  return value;
}

export function readAIConfig(env: Env = process.env): AIConfig {
  const availability = readAIAvailability(env);
  if (!availability.available) throw new AIUnavailableError(availability.reason);
  const provider = availability.provider;
  const model = required(env, 'AI_MODEL', provider);

  switch (provider) {
    case 'azure':
      return {
        provider,
        model,
        resourceName: required(env, 'AZURE_OPENAI_RESOURCE_NAME', provider),
      };
    case 'groq':
      return { provider, model, apiKey: required(env, 'GROQ_API_KEY', provider) };
    case 'google':
      return {
        provider,
        model,
        apiKey: required(env, 'GOOGLE_GENERATIVE_AI_API_KEY', provider),
      };
    case 'vertex': {
      const apiKey = env.GOOGLE_VERTEX_API_KEY?.trim();
      if (apiKey) return { provider, model, apiKey };
      return {
        provider,
        model,
        project: required(env, 'GOOGLE_VERTEX_PROJECT', provider),
        location: required(env, 'GOOGLE_VERTEX_LOCATION', provider),
      };
    }
  }
}

export function createAIModel(env: Env = process.env): AIModelSelection {
  const config = readAIConfig(env);

  switch (config.provider) {
    case 'azure': {
      const tokenProvider = getBearerTokenProvider(
        new DefaultAzureCredential(),
        'https://cognitiveservices.azure.com/.default'
      );
      return {
        model: createAzure({ resourceName: config.resourceName, tokenProvider })(config.model),
        provider: config.provider,
        modelId: config.model,
        providerOptions: { azure: { parallelToolCalls: false } },
      };
    }
    case 'groq':
      return {
        model: createGroq({ apiKey: config.apiKey })(config.model),
        provider: config.provider,
        modelId: config.model,
        providerOptions: { groq: { parallelToolCalls: false } },
      };
    case 'google':
      return {
        model: createGoogleGenerativeAI({ apiKey: config.apiKey })(config.model),
        provider: config.provider,
        modelId: config.model,
      };
    case 'vertex': {
      const vertex = createVertex(
        config.apiKey
          ? { apiKey: config.apiKey }
          : { project: config.project, location: config.location }
      );
      return { model: vertex(config.model), provider: config.provider, modelId: config.model };
    }
  }
}

/** Create the concrete model selected by the persisted tenant-budget router. */
export function createRoutedAIModel(
  selection: { provider: RoutedAIProvider; model: string },
  env: Env = process.env
): AIModelSelection {
  if (selection.provider === 'anthropic') {
    return {
      model: createAnthropic({ apiKey: required(env, 'ANTHROPIC_API_KEY', 'anthropic') })(
        selection.model
      ),
      provider: 'anthropic',
      modelId: selection.model,
    };
  }
  return {
    model: createAmazonBedrock({
      region: required(env, 'AWS_REGION', 'bedrock'),
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN,
    })(selection.model),
    provider: 'bedrock',
    modelId: selection.model,
  };
}
