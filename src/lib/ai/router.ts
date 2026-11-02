import 'server-only';

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import { generateText, type CallSettings, type Prompt } from 'ai';

import {
  AI_TIERS,
  ROUTED_AI_PROVIDERS,
  envMonthlyCapUsd,
  envProviderOrder,
  getDefaultModelId,
  type TieredAIProviderName,
} from './model-defaults';
import {
  AIUnavailableError,
  createAIModel,
  createTieredModel,
  isRoutedProviderConfigured,
  readAISelector,
  type AIUnavailableReason,
} from './provider';
import type { RoutedCallContext } from './routed-model';
import { loadProviderAPIKey } from './secrets';
import {
  readProviderSpend,
  readStoredAISettings,
  recordAIUsage,
  recordProviderUsage,
  type AIRoutingMode,
  type ProviderUsageWrite,
  type StoredAISettings,
} from './spend';
import type { AITier } from './tiers';

type Env = Record<string, string | undefined>;
type Provider = TieredAIProviderName;

/** Effective routing policy: SuperAdmin overrides, then environment, then defaults. */
export type RoutingSettings = {
  mode: AIRoutingMode;
  providerOrder: Provider[];
  fallbackEnabled: boolean;
  capsUsd: Record<Provider, number>;
  models: Record<Provider, Record<AITier, string>>;
  source: 'superadmin' | 'environment';
};

export function resolveRoutingSettings(stored: StoredAISettings | null, env: Env = process.env): RoutingSettings {
  const savedOrder = [...new Set(stored?.providerOrder ?? [])];
  const models = {} as Record<Provider, Record<AITier, string>>;
  const capsUsd = {} as Record<Provider, number>;
  for (const provider of ROUTED_AI_PROVIDERS) {
    capsUsd[provider] = stored?.capsUsd[provider] ?? envMonthlyCapUsd(provider, env);
    models[provider] = {} as Record<AITier, string>;
    for (const tier of AI_TIERS) {
      models[provider][tier] = getDefaultModelId(provider, tier, stored?.models[provider], env);
    }
  }
  return {
    mode: stored?.mode ?? 'Auto',
    providerOrder: savedOrder.length ? savedOrder : envProviderOrder(env),
    fallbackEnabled: stored?.fallbackEnabled ?? true,
    capsUsd,
    models,
    source: stored ? 'superadmin' : 'environment',
  };
}

const FORCED_PROVIDER: Record<AIRoutingMode, Provider | null> = {
  Auto: null,
  ForceAnthropic: 'anthropic',
  ForceOpenAI: 'openai',
  ForceBedrock: 'bedrock',
  Disabled: null,
};

/**
 * The providers to try, in order. A SuperAdmin-forced provider goes first, else an
 * explicit AI_PROVIDER=<routed provider>, then the configured order. With fallback
 * off only the first is tried. Azure can never appear: it is not a routed provider.
 */
export function candidateChain(settings: RoutingSettings, env: Env = process.env): Provider[] {
  if (settings.mode === 'Disabled') return [];
  const selector = readAISelector(env);
  const first =
    FORCED_PROVIDER[settings.mode] ?? (selector.kind === 'routed' ? selector.preferred : null);
  const order = first
    ? [first, ...settings.providerOrder.filter((provider) => provider !== first)]
    : settings.providerOrder;
  return settings.fallbackEnabled ? order : order.slice(0, 1);
}

/** Calendar-month bounds for Pakistan Standard Time (UTC+05:00; no DST). */
export function karachiMonthBounds(now: Date): { from: Date; to: Date } {
  const pkt = new Date(now.getTime() + 5 * 60 * 60 * 1000);
  const year = pkt.getUTCFullYear();
  const month = pkt.getUTCMonth();
  return {
    from: new Date(Date.UTC(year, month, 1) - 5 * 60 * 60 * 1000),
    to: new Date(Date.UTC(year, month + 1, 1) - 5 * 60 * 60 * 1000),
  };
}

export type RouterDependencies = {
  now: () => Date;
  storedSettings: () => Promise<StoredAISettings | null>;
  spend: (provider: Provider, from: Date, to: Date) => Promise<number>;
  apiKey: (provider: 'anthropic' | 'openai', env: Env) => Promise<string | null>;
  model: (input: { provider: Provider; modelId: string; apiKey: string | null; env: Env }) => LanguageModelV3;
  record: (usage: ProviderUsageWrite) => Promise<unknown>;
  /** Best-effort cap alert after a recorded attempt. */
  alert?: (provider: Provider, now: Date) => Promise<unknown>;
};

const defaultDependencies: RouterDependencies = {
  now: () => new Date(),
  storedSettings: readStoredAISettings,
  spend: readProviderSpend,
  apiKey: (provider, env) => loadProviderAPIKey(provider, env),
  model: (input) => createTieredModel(input) as LanguageModelV3,
  record: recordProviderUsage,
  alert: async (provider, now) => (await import('./usage')).maybeCreateAIBudgetAlert(provider, now),
};

let dependencies = defaultDependencies;
let settingsCache: { expiresAt: number; value: StoredAISettings | null } | undefined;
const SETTINGS_CACHE_MS = 30_000;

async function storedSettingsCached(now: Date): Promise<StoredAISettings | null> {
  if (settingsCache && settingsCache.expiresAt > now.getTime()) return settingsCache.value;
  let value: StoredAISettings | null;
  try {
    value = await dependencies.storedSettings();
  } catch (error) {
    // Settings are optional overrides: without them the environment policy applies.
    console.error('[ai-router] could not read SuperAdmin AI settings; using environment defaults', {
      error: errorName(error),
    });
    value = null;
  }
  settingsCache = { value, expiresAt: now.getTime() + SETTINGS_CACHE_MS };
  return value;
}

export async function readRoutingSettings(env: Env = process.env, now = dependencies.now()) {
  return resolveRoutingSettings(await storedSettingsCached(now), env);
}

function errorName(error: unknown): string {
  return error && typeof error === 'object' && 'name' in error ? String(error.name) : 'Error';
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { statusCode?: unknown; status?: unknown };
  const status = candidate.statusCode ?? candidate.status;
  return typeof status === 'number' ? status : undefined;
}

function isAbort(error: unknown, options: LanguageModelV3CallOptions): boolean {
  if (options.abortSignal?.aborted) return true;
  const name = errorName(error);
  return name === 'AbortError' || name === 'TimeoutError';
}

type SkipReason = 'NOT_CONFIGURED' | 'CAPPED' | 'SPEND_UNKNOWN';
type Attempt = { provider: Provider; modelId: string; model: LanguageModelV3 };

async function prepareAttempt(
  provider: Provider,
  context: RoutedCallContext,
  settings: RoutingSettings,
  env: Env,
  now: Date
): Promise<Attempt | { skip: SkipReason }> {
  if (!isRoutedProviderConfigured(provider, env)) return { skip: 'NOT_CONFIGURED' };
  const bounds = karachiMonthBounds(now);
  let spent: number;
  try {
    spent = await dependencies.spend(provider, bounds.from, bounds.to);
  } catch (error) {
    // A cap that cannot be checked is not enforced by guessing: skip the provider.
    console.error('[ai-router] could not read provider spend; skipping provider', {
      provider,
      error: errorName(error),
    });
    return { skip: 'SPEND_UNKNOWN' };
  }
  if (spent >= settings.capsUsd[provider]) return { skip: 'CAPPED' };
  const apiKey = provider === 'bedrock' ? null : await dependencies.apiKey(provider, env);
  if (provider !== 'bedrock' && !apiKey) return { skip: 'NOT_CONFIGURED' };
  const modelId = settings.models[provider][context.tier];
  return { provider, modelId, model: dependencies.model({ provider, modelId, apiKey, env }) };
}

/** OpenAI must not retain prompts or responses. */
function callOptionsFor(provider: Provider, options: LanguageModelV3CallOptions): LanguageModelV3CallOptions {
  if (provider !== 'openai') return options;
  return {
    ...options,
    providerOptions: {
      ...options.providerOptions,
      openai: { ...options.providerOptions?.openai, store: false },
    },
  };
}

function tokenCounts(usage: LanguageModelV3Usage | undefined) {
  return {
    inputTokens: Math.max(0, usage?.inputTokens.total ?? 0),
    outputTokens: Math.max(0, usage?.outputTokens.total ?? 0),
  };
}

async function recordAttempt(
  attempt: Attempt,
  context: RoutedCallContext,
  usage: LanguageModelV3Usage | undefined,
  now: Date
) {
  try {
    await dependencies.record({
      provider: attempt.provider,
      tier: context.tier,
      model: attempt.modelId,
      feature: context.feature,
      organizationId: context.organizationId,
      ...tokenCounts(usage),
      createdAt: now,
    });
  } catch (error) {
    // Fail-open: paid output is never discarded because the ledger is unavailable.
    console.error('[ai-router] could not record provider usage', {
      provider: attempt.provider,
      error: errorName(error),
    });
    return;
  }
  void dependencies.alert?.(attempt.provider, now).catch(() => undefined);
}

type Failure = { provider: Provider; error: unknown };

function exhausted(skipped: SkipReason[], failures: Failure[]): AIUnavailableError {
  let reason: AIUnavailableReason;
  if (failures.length) reason = 'PROVIDERS_FAILED';
  else if (skipped.includes('CAPPED') || skipped.includes('SPEND_UNKNOWN')) reason = 'CAPPED';
  else reason = 'NOT_CONFIGURED';
  return new AIUnavailableError(reason, 'AI is currently unavailable.', {
    cause: failures.at(-1)?.error,
  });
}

function logFailure(provider: Provider, error: unknown) {
  console.warn('[ai-router] provider attempt failed; trying the next provider', {
    provider,
    error: errorName(error),
    status: statusOf(error),
  });
}

async function plan(context: RoutedCallContext) {
  const env = context.env ?? process.env;
  const now = dependencies.now();
  const settings = await readRoutingSettings(env, now);
  if (settings.mode === 'Disabled') {
    throw new AIUnavailableError('DISABLED', 'AI is disabled by the platform routing policy.');
  }
  return { env, now, settings, chain: candidateChain(settings, env) };
}

const routingMetadata = (attempt: Attempt) => ({
  devfathomRouting: { provider: attempt.provider, modelId: attempt.modelId },
});

/**
 * One complete call through the chain. A provider that is unconfigured or at its
 * cap is skipped; a provider that throws (auth, rate limit, 5xx, network) hands
 * over to the next. Cancellation is never retried elsewhere.
 */
export async function routedGenerate(
  context: RoutedCallContext,
  options: LanguageModelV3CallOptions
): Promise<LanguageModelV3GenerateResult> {
  const { env, now, settings, chain } = await plan(context);
  const skipped: SkipReason[] = [];
  const failures: Failure[] = [];
  for (const provider of chain) {
    const attempt = await prepareAttempt(provider, context, settings, env, now);
    if ('skip' in attempt) {
      skipped.push(attempt.skip);
      continue;
    }
    let result: LanguageModelV3GenerateResult;
    try {
      result = await attempt.model.doGenerate(callOptionsFor(provider, options));
    } catch (error) {
      if (isAbort(error, options)) throw error;
      logFailure(provider, error);
      failures.push({ provider, error });
      continue;
    }
    await recordAttempt(attempt, context, result.usage, now);
    return { ...result, providerMetadata: { ...result.providerMetadata, ...routingMetadata(attempt) } };
  }
  throw exhausted(skipped, failures);
}

/**
 * Streaming through the chain. Failover is only possible before the stream is
 * returned (connection, auth, rate limit and 5xx all fail there); once bytes
 * flow, an error belongs to that provider's stream.
 */
export async function routedStream(
  context: RoutedCallContext,
  options: LanguageModelV3CallOptions
): Promise<LanguageModelV3StreamResult> {
  const { env, now, settings, chain } = await plan(context);
  const skipped: SkipReason[] = [];
  const failures: Failure[] = [];
  for (const provider of chain) {
    const attempt = await prepareAttempt(provider, context, settings, env, now);
    if ('skip' in attempt) {
      skipped.push(attempt.skip);
      continue;
    }
    let result: LanguageModelV3StreamResult;
    try {
      result = await attempt.model.doStream(callOptionsFor(provider, options));
    } catch (error) {
      if (isAbort(error, options)) throw error;
      logFailure(provider, error);
      failures.push({ provider, error });
      continue;
    }
    const metered = result.stream.pipeThrough(
      new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
        async transform(part, controller) {
          if (part.type === 'finish') {
            await recordAttempt(attempt, context, part.usage, now);
            controller.enqueue({
              ...part,
              providerMetadata: { ...part.providerMetadata, ...routingMetadata(attempt) },
            });
            return;
          }
          controller.enqueue(part);
        },
      })
    );
    return { ...result, stream: metered };
  }
  throw exhausted(skipped, failures);
}

/**
 * Whether a routed call could be attempted right now: not disabled by the
 * SuperAdmin switch, and some candidate is configured and under its cap. Lets a
 * route answer with its unavailable state before it starts streaming.
 */
export async function readRoutedAvailability(
  env: Env = process.env
): Promise<{ available: true } | { available: false; reason: AIUnavailableReason }> {
  const now = dependencies.now();
  const settings = await readRoutingSettings(env, now);
  if (settings.mode === 'Disabled') return { available: false, reason: 'DISABLED' };
  const bounds = karachiMonthBounds(now);
  let sawCap = false;
  for (const provider of candidateChain(settings, env)) {
    if (!isRoutedProviderConfigured(provider, env)) continue;
    try {
      if ((await dependencies.spend(provider, bounds.from, bounds.to)) < settings.capsUsd[provider]) {
        return { available: true };
      }
    } catch {
      // Unknown spend is treated as capped, as in prepareAttempt.
    }
    sawCap = true;
  }
  return { available: false, reason: sawCap ? 'CAPPED' : 'NOT_CONFIGURED' };
}

// ---------------------------------------------------------------------------
// Tenant-attributed generation (develop, #663).
// ---------------------------------------------------------------------------

type RoutedAIInput = CallSettings &
  Prompt & {
    organizationId: string;
    branchId: string;
    feature: string;
    tier?: AITier;
  };

type RoutingMetadata = { provider?: unknown; modelId?: unknown };

/**
 * Generate through the configured provider (the routed chain, or a legacy
 * explicit provider) and meter the successful call against the tenant and branch.
 *
 * Metering is deliberately fail-open: once a provider has returned paid output,
 * a telemetry outage must not discard it and cause a retry to buy it again.
 */
export async function routeAI(input: RoutedAIInput) {
  const { organizationId, branchId, feature, tier, ...settings } = input;
  const selection = createAIModel(process.env, { feature, tier, organizationId });
  const result = await generateText({
    ...settings,
    model: selection.model,
    providerOptions: selection.providerOptions,
  });

  const routed = result.providerMetadata?.devfathomRouting as RoutingMetadata | undefined;
  try {
    await recordAIUsage({
      organizationId,
      branchId,
      feature,
      provider: typeof routed?.provider === 'string' ? routed.provider : selection.provider,
      model: typeof routed?.modelId === 'string' ? routed.modelId : selection.modelId,
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    });
  } catch {
    // Best-effort telemetry only; never throw away successfully purchased output.
  }

  return result;
}

export function __setRouterDependenciesForTests(overrides: Partial<RouterDependencies> | null) {
  dependencies = overrides ? { ...defaultDependencies, ...overrides } : defaultDependencies;
  settingsCache = undefined;
}
