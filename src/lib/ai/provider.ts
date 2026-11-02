import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createVertex } from '@ai-sdk/google-vertex';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { LanguageModel } from 'ai';

import { API_KEY_SECRET_ID_ENV, apiKeySource } from './ai-credentials';
import {
  bedrockRegion,
  envProviderOrder,
  isRoutedProvider,
  type TieredAIProviderName,
} from './model-defaults';
import { createRoutedLanguageModel } from './routed-model';
import { getTierForFeature, type AITier } from './tiers';

type Env = Record<string, string | undefined>;

/** Explicit-only providers with their original single-model path. Never routed. */
export type LegacyAIProviderName = 'azure' | 'groq' | 'google' | 'vertex';
/** `auto` is the routed chain (Anthropic → OpenAI → Bedrock by default). */
export type AIProviderName = LegacyAIProviderName | TieredAIProviderName | 'auto';

const LEGACY_PROVIDERS: ReadonlySet<string> = new Set(['azure', 'groq', 'google', 'vertex']);

export type AISelector =
  | { kind: 'disabled' }
  | { kind: 'invalid' }
  | { kind: 'legacy'; provider: LegacyAIProviderName }
  /** `preferred` comes first in the chain. */
  | { kind: 'routed'; preferred: TieredAIProviderName | null };

/**
 * AI_PROVIDER:
 *   unset / blank                  → off: AI is never on by default (production stays off
 *                                    until it is set up; develop opts in with `auto`)
 *   `auto`                         → routed chain, if any routed provider is configured
 *   `anthropic` / `openai` / `bedrock` → routed chain with that provider first
 *   `azure` / `groq` / `google` / `vertex` → the legacy single-provider path, unchanged
 *   `disabled`                     → off
 */
export function readAISelector(env: Env = process.env): AISelector {
  const selector = env.AI_PROVIDER?.trim().toLowerCase();
  if (selector === 'disabled') return { kind: 'disabled' };
  if (selector && LEGACY_PROVIDERS.has(selector)) {
    return { kind: 'legacy', provider: selector as LegacyAIProviderName };
  }
  if (!selector) return { kind: 'disabled' };
  if (selector === 'auto') return { kind: 'routed', preferred: null };
  if (isRoutedProvider(selector)) return { kind: 'routed', preferred: selector };
  return { kind: 'invalid' };
}

/**
 * Whether a routed provider has what it needs to be attempted. Configuration only:
 * no network call, no secret read. Anthropic and OpenAI need a Secrets Manager
 * secret id (or, outside production, a plain key). Bedrock authenticates with the
 * instance role and needs only its region set.
 */
export function isRoutedProviderConfigured(provider: TieredAIProviderName, env: Env = process.env) {
  if (provider === 'bedrock') {
    return (
      Boolean(env.BEDROCK_REGION?.trim() || env.AI_BEDROCK_REGION?.trim()) ||
      env.AI_PROVIDER?.trim().toLowerCase() === 'bedrock'
    );
  }
  return apiKeySource(provider, env) !== null;
}

/** The configured routed providers, preferred first, then AI_PROVIDER_ORDER. */
export function configuredRoutedProviders(env: Env = process.env): TieredAIProviderName[] {
  const selector = readAISelector(env);
  const order = envProviderOrder(env);
  const preferred = selector.kind === 'routed' ? selector.preferred : null;
  const chain = preferred ? [preferred, ...order.filter((name) => name !== preferred)] : order;
  return chain.filter((name) => isRoutedProviderConfigured(name, env));
}

export type AIAvailability =
  | { available: true; provider: AIProviderName }
  | { available: false; reason: 'DISABLED' | 'INVALID_PROVIDER' | 'NOT_CONFIGURED' };

/** Configuration gate. `available` does not assert provider health, spend or SuperAdmin state. */
export function readAIAvailability(env: Env = process.env): AIAvailability {
  const selector = readAISelector(env);
  switch (selector.kind) {
    case 'disabled':
      return { available: false, reason: 'DISABLED' };
    case 'invalid':
      return { available: false, reason: 'INVALID_PROVIDER' };
    case 'legacy':
      return { available: true, provider: selector.provider };
    case 'routed':
      if (configuredRoutedProviders(env).length) return { available: true, provider: 'auto' };
      return { available: false, reason: 'NOT_CONFIGURED' };
  }
}

export type AIUnavailableReason =
  | 'DISABLED'
  | 'INVALID_PROVIDER'
  | 'NOT_CONFIGURED'
  /** Every candidate provider has reached its monthly spend cap. */
  | 'CAPPED'
  /** Every candidate provider was attempted and failed. */
  | 'PROVIDERS_FAILED';

export class AIUnavailableError extends Error {
  constructor(
    readonly reason: AIUnavailableReason,
    message = 'AI is currently unavailable.',
    options?: { cause?: unknown }
  ) {
    super(message, options);
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
    }
  | {
      provider: 'auto';
      model: 'auto';
      preferred: TieredAIProviderName | null;
      chain: TieredAIProviderName[];
    };

export type AIModelSelection = {
  model: LanguageModel;
  provider: AIProviderName;
  modelId: string;
  providerOptions?: Record<string, Record<string, boolean>>;
};

export type AIProviderReadiness =
  | { ready: true; provider: AIProviderName; modelId: string }
  | {
      ready: false;
      reason: 'DISABLED' | 'INVALID_PROVIDER' | 'MISSING_CONFIG' | 'INVALID_MODEL';
      provider: AIProviderName | null;
      /** Environment variable names only; values are never read into this result. */
      missing: string[];
      invalid: string[];
    };

// A model id starts with a letter or digit and carries no whitespace, quotes or
// template syntax, so an unexpanded placeholder such as `${AI_MODEL}` is refused.
const MODEL_ID = /^[A-Za-z0-9][\w.:/@+-]{0,255}$/;

function present(env: Env, name: string): boolean {
  return Boolean(env[name]?.trim());
}

/** Settings each legacy provider needs beyond AI_PROVIDER and AI_MODEL, in the order they are read. */
const LEGACY_PROVIDER_SETTINGS: Record<LegacyAIProviderName, (env: Env) => string[]> = {
  azure: () => ['AZURE_OPENAI_RESOURCE_NAME'],
  groq: () => ['GROQ_API_KEY'],
  google: () => ['GOOGLE_GENERATIVE_AI_API_KEY'],
  // An API key replaces the project/location pair.
  vertex: (env) =>
    present(env, 'GOOGLE_VERTEX_API_KEY')
      ? []
      : ['GOOGLE_VERTEX_PROJECT', 'GOOGLE_VERTEX_LOCATION'],
};

/** What a routed provider needs, named for the readiness report. */
function routedProviderSettingNames(provider: TieredAIProviderName): string[] {
  return provider === 'bedrock' ? ['BEDROCK_REGION'] : [API_KEY_SECRET_ID_ENV[provider]];
}

/**
 * Whether the selected provider has every setting it needs to be called.
 * Configuration only: it makes no network call and does not prove the provider
 * is healthy, under its spend cap, or enabled by the SuperAdmin switch.
 */
export function readAIProviderReadiness(env: Env = process.env): AIProviderReadiness {
  const selector = readAISelector(env);
  if (selector.kind === 'routed') {
    if (configuredRoutedProviders(env).length)
      return { ready: true, provider: 'auto', modelId: 'auto' };
    const wanted = selector.preferred ? [selector.preferred] : envProviderOrder(env);
    return {
      ready: false,
      reason: 'MISSING_CONFIG',
      provider: selector.preferred ?? 'auto',
      missing: wanted.flatMap(routedProviderSettingNames),
      invalid: [],
    };
  }
  if (selector.kind === 'disabled') {
    return {
      ready: false,
      reason: 'DISABLED',
      provider: null,
      missing: ['AI_PROVIDER'],
      invalid: [],
    };
  }
  if (selector.kind === 'invalid') {
    return {
      ready: false,
      reason: 'INVALID_PROVIDER',
      provider: null,
      missing: [],
      invalid: ['AI_PROVIDER'],
    };
  }
  const provider = selector.provider;
  const model = env.AI_MODEL?.trim() ?? '';
  const missing = [
    ...(model ? [] : ['AI_MODEL']),
    ...LEGACY_PROVIDER_SETTINGS[provider](env).filter((name) => !present(env, name)),
  ];
  if (missing.length)
    return { ready: false, reason: 'MISSING_CONFIG', provider, missing, invalid: [] };
  if (!MODEL_ID.test(model)) {
    return { ready: false, reason: 'INVALID_MODEL', provider, missing: [], invalid: ['AI_MODEL'] };
  }
  return { ready: true, provider, modelId: model };
}

export function readAIConfig(env: Env = process.env): AIConfig {
  const availability = readAIAvailability(env);
  if (!availability.available) throw new AIUnavailableError(availability.reason);
  const selector = readAISelector(env);
  if (selector.kind === 'routed') {
    return {
      provider: 'auto',
      model: 'auto',
      preferred: selector.preferred,
      chain: configuredRoutedProviders(env),
    };
  }
  const provider = availability.provider as LegacyAIProviderName;
  // The same readiness rule gates Ask Fathom, so the factory cannot accept what it refuses.
  const readiness = readAIProviderReadiness(env);
  if (!readiness.ready) {
    const [name, problem] = readiness.missing.length
      ? [readiness.missing[0], 'required']
      : [readiness.invalid[0], 'invalid'];
    throw new Error(`[ai:${provider}] ${name} is ${problem}.`);
  }
  const model = readiness.modelId;

  switch (provider) {
    case 'azure':
      return {
        provider,
        model,
        resourceName: env.AZURE_OPENAI_RESOURCE_NAME!.trim(),
      };
    case 'groq':
      return { provider, model, apiKey: env.GROQ_API_KEY!.trim() };
    case 'google':
      return { provider, model, apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY!.trim() };
    case 'vertex': {
      const apiKey = env.GOOGLE_VERTEX_API_KEY?.trim();
      if (apiKey) return { provider, model, apiKey };
      return {
        provider,
        model,
        project: env.GOOGLE_VERTEX_PROJECT!.trim(),
        location: env.GOOGLE_VERTEX_LOCATION!.trim(),
      };
    }
  }
}

export type CreateAIModelOptions = {
  /** Model tier; defaults to the feature's tier, or `standard`. */
  tier?: AITier;
  /** Stable feature identifier, recorded with routed spend. */
  feature?: string;
  /** Attribution only; never a tenancy boundary for the platform ledger. */
  organizationId?: string | null;
};

export function createAIModel(
  env: Env = process.env,
  options: CreateAIModelOptions = {}
): AIModelSelection {
  const config = readAIConfig(env);

  switch (config.provider) {
    case 'auto': {
      const tier =
        options.tier ?? (options.feature ? getTierForFeature(options.feature) : 'standard');
      return {
        model: createRoutedLanguageModel({
          tier,
          feature: options.feature ?? 'unattributed',
          organizationId: options.organizationId ?? null,
          env: env === process.env ? undefined : env,
        }),
        provider: 'auto',
        modelId: `auto:${tier}`,
      };
    }
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

/**
 * One concrete routed-provider model. Anthropic and OpenAI need the key the
 * caller resolved (from Secrets Manager); Bedrock uses the default AWS credential
 * chain (the EC2 instance / task role) and never static keys.
 */
export function createTieredModel(input: {
  provider: TieredAIProviderName;
  modelId: string;
  apiKey?: string | null;
  env?: Env;
}) {
  switch (input.provider) {
    case 'anthropic':
      if (!input.apiKey) throw new AIUnavailableError('NOT_CONFIGURED');
      return createAnthropic({ apiKey: input.apiKey })(input.modelId);
    case 'openai':
      if (!input.apiKey) throw new AIUnavailableError('NOT_CONFIGURED');
      return createOpenAI({ apiKey: input.apiKey })(input.modelId);
    case 'bedrock':
      return createAmazonBedrock({
        region: bedrockRegion(input.env ?? process.env),
        credentialProvider: fromNodeProviderChain(),
      })(input.modelId);
  }
}
