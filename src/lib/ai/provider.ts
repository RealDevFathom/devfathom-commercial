import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createVertex } from '@ai-sdk/google-vertex';
import { createGroq } from '@ai-sdk/groq';
import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import type { LanguageModel } from 'ai';

type Env = Record<string, string | undefined>;
export type AIProviderName = 'azure' | 'groq' | 'google' | 'vertex';

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
  provider: AIProviderName;
  modelId: string;
  providerOptions?: Record<string, Record<string, boolean>>;
};

function required(env: Env, name: string, provider: AIProviderName): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`[ai:${provider}] ${name} is required.`);
  return value;
}

export function readAIConfig(env: Env = process.env): AIConfig {
  const rawProvider = required(env, 'AI_PROVIDER', 'azure').toLowerCase();
  if (!['azure', 'groq', 'google', 'vertex'].includes(rawProvider)) {
    throw new Error(
      `[ai] Unsupported AI_PROVIDER "${rawProvider}". Use azure, groq, google, or vertex.`
    );
  }
  const provider = rawProvider as AIProviderName;
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
