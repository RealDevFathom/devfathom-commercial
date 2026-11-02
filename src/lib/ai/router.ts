import 'server-only';

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import { generateText, type CallSettings, type Prompt } from 'ai';

import { maskPersonalDataInPrompt } from './mask-personal-data';
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
import {
  FAILURE_POLICY,
  classifyProviderError,
  retryDelayMs,
  type ProviderFailure,
} from './provider-errors';
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
import { claimModelCall, remainingMs } from './turn-budget';
import { needsDeepStrategyOptIn, resolveWorkload, type WorkloadPolicy } from './workload';

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

export function resolveRoutingSettings(
  stored: StoredAISettings | null,
  env: Env = process.env
): RoutingSettings {
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

/**
 * The chain for one call's workload: a workload pinned to providers (the weekly owner
 * summary: Anthropic only) ignores the order and fallback settings, and a workload
 * without failover tries only its first provider. Disabled is always empty.
 */
export function workloadChain(
  settings: RoutingSettings,
  workload: WorkloadPolicy,
  env: Env = process.env
): Provider[] {
  if (settings.mode === 'Disabled') return [];
  const chain = workload.providers ? [...workload.providers] : candidateChain(settings, env);
  return workload.failover ? chain : chain.slice(0, 1);
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
  model: (input: {
    provider: Provider;
    modelId: string;
    apiKey: string | null;
    env: Env;
  }) => LanguageModelV3;
  record: (usage: ProviderUsageWrite) => Promise<unknown>;
  /** Best-effort cap alert after a recorded attempt. */
  alert?: (provider: Provider, now: Date) => Promise<unknown>;
  /** Best-effort SuperAdmin notification after a 401; the router dedupes per hour first. */
  authAlert?: (provider: Provider, now: Date) => Promise<unknown>;
  /** The organization's deep-strategy opt-in (tenant database). Cached 30 s; a failure means no. */
  deepStrategyEnabled: (organizationId: string) => Promise<boolean>;
  /** The wait before the one retry. Must end early, without throwing, when `signal` aborts. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Jitter source in [0, 1). */
  random: () => number;
};

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

const defaultDependencies: RouterDependencies = {
  now: () => new Date(),
  storedSettings: readStoredAISettings,
  spend: readProviderSpend,
  apiKey: (provider, env) => loadProviderAPIKey(provider, env),
  model: (input) => createTieredModel(input) as LanguageModelV3,
  record: recordProviderUsage,
  alert: async (provider, now) => (await import('./usage')).maybeCreateAIBudgetAlert(provider, now),
  authAlert: async (provider, now) =>
    (await import('./usage')).maybeCreateAIAuthFailureAlert(provider, now),
  deepStrategyEnabled: async (organizationId) =>
    (await import('./deep-strategy-settings')).readDeepStrategyEnabled(organizationId),
  sleep: abortableSleep,
  random: Math.random,
};

let dependencies = defaultDependencies;
let settingsCache: { expiresAt: number; value: StoredAISettings | null } | undefined;
const SETTINGS_CACHE_MS = 30_000;
const DEEP_STRATEGY_CACHE_MS = 30_000;
const deepStrategyCache = new Map<string, { expiresAt: number; value: boolean }>();

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

async function deepStrategyEnabledCached(organizationId: string, now: Date): Promise<boolean> {
  const cached = deepStrategyCache.get(organizationId);
  if (cached && cached.expiresAt > now.getTime()) return cached.value;
  try {
    const value = (await dependencies.deepStrategyEnabled(organizationId)) === true;
    deepStrategyCache.set(organizationId, {
      value,
      expiresAt: now.getTime() + DEEP_STRATEGY_CACHE_MS,
    });
    return value;
  } catch (error) {
    // Unknown opt-in is no opt-in: the call runs on the standard model. Not cached,
    // so the next call reads again.
    console.error('[ai-router] could not read the deep-strategy opt-in; using the standard model', {
      error: errorName(error),
    });
    return false;
  }
}

export async function readRoutingSettings(env: Env = process.env, now = dependencies.now()) {
  return resolveRoutingSettings(await storedSettingsCached(now), env);
}

function errorName(error: unknown): string {
  return error && typeof error === 'object' && 'name' in error ? String(error.name) : 'Error';
}

// ---------------------------------------------------------------------------
// Circuit breaker: one per provider, in memory (per server process).
// ---------------------------------------------------------------------------

export const CIRCUIT_FAILURE_THRESHOLD = 5;
export const CIRCUIT_WINDOW_MS = 60_000;
export const CIRCUIT_OPEN_MS = 60_000;
/** Billing and auth stops keep the provider out for longer. */
export const CIRCUIT_LONG_OPEN_MS = 600_000;

type Circuit = {
  /** Times of consecutive counted failures still inside the window. */
  failures: number[];
  /** 0 when closed; otherwise open until this time, then half-open. */
  openUntil: number;
  /** A half-open probe is in flight; everyone else is still skipped. */
  probing: boolean;
};

const circuits = new Map<Provider, Circuit>();

function circuitOf(provider: Provider): Circuit {
  let circuit = circuits.get(provider);
  if (!circuit) {
    circuit = { failures: [], openUntil: 0, probing: false };
    circuits.set(provider, circuit);
  }
  return circuit;
}

/** Whether a call may go to the provider now. Taking the half-open probe claims it. */
function circuitAdmits(provider: Provider, now: number): boolean {
  const circuit = circuits.get(provider);
  if (!circuit || circuit.openUntil === 0) return true;
  if (now < circuit.openUntil || circuit.probing) return false;
  circuit.probing = true;
  return true;
}

/** The same question without claiming the probe. */
function circuitWouldAdmit(provider: Provider, now: number): boolean {
  const circuit = circuits.get(provider);
  return !circuit || circuit.openUntil === 0 || (now >= circuit.openUntil && !circuit.probing);
}

function circuitIsOpen(provider: Provider, now: number): boolean {
  const circuit = circuits.get(provider);
  return Boolean(
    circuit && circuit.openUntil !== 0 && (now < circuit.openUntil || circuit.probing)
  );
}

type CircuitOutcome = 'success' | 'count' | 'open-long' | 'release';

function recordCircuit(provider: Provider, outcome: CircuitOutcome, now: number) {
  if (outcome === 'success') {
    circuits.delete(provider);
    return;
  }
  const circuit = circuitOf(provider);
  if (outcome === 'release') {
    // The probe ended without an answer either way (the caller aborted): let the
    // next call probe instead.
    circuit.probing = false;
    return;
  }
  if (outcome === 'open-long') {
    circuit.openUntil = Math.max(circuit.openUntil, now + CIRCUIT_LONG_OPEN_MS);
    circuit.failures = [];
    circuit.probing = false;
    return;
  }
  if (circuit.probing) {
    circuit.openUntil = now + CIRCUIT_OPEN_MS;
    circuit.failures = [];
    circuit.probing = false;
    return;
  }
  circuit.failures = [...circuit.failures.filter((at) => now - at < CIRCUIT_WINDOW_MS), now];
  if (circuit.failures.length >= CIRCUIT_FAILURE_THRESHOLD) {
    circuit.openUntil = now + CIRCUIT_OPEN_MS;
    circuit.failures = [];
  }
}

// ---------------------------------------------------------------------------
// 401 alert, deduped per provider per UTC hour in this process (the notification
// rows are also deduped per hour in the database).
// ---------------------------------------------------------------------------

const authAlertHours = new Map<Provider, string>();

function alertAuthFailure(provider: Provider, now: Date) {
  const hour = now.toISOString().slice(0, 13);
  if (authAlertHours.get(provider) === hour) return;
  authAlertHours.set(provider, hour);
  void dependencies.authAlert?.(provider, now).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// One routed call.
// ---------------------------------------------------------------------------

type SkipReason = 'NOT_CONFIGURED' | 'CAPPED' | 'SPEND_UNKNOWN' | 'CIRCUIT_OPEN';
type Attempt = { provider: Provider; modelId: string; model: LanguageModelV3 };

type Planned = {
  env: Env;
  now: Date;
  settings: RoutingSettings;
  workload: WorkloadPolicy;
  chain: Provider[];
};

async function prepareAttempt(
  provider: Provider,
  planned: Planned
): Promise<Attempt | { skip: SkipReason }> {
  const { env, now, settings, workload } = planned;
  if (!isRoutedProviderConfigured(provider, env)) return { skip: 'NOT_CONFIGURED' };
  if (!circuitWouldAdmit(provider, dependencies.now().getTime())) return { skip: 'CIRCUIT_OPEN' };
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
  // Claimed last, so a skipped provider never holds the half-open probe.
  if (!circuitAdmits(provider, dependencies.now().getTime())) return { skip: 'CIRCUIT_OPEN' };
  const modelId = settings.models[provider][workload.tier];
  return { provider, modelId, model: dependencies.model({ provider, modelId, apiKey, env }) };
}

/** OpenAI must not retain prompts or responses; Bedrock never receives personal data. */
function callOptionsFor(
  provider: Provider,
  options: LanguageModelV3CallOptions
): LanguageModelV3CallOptions {
  if (provider === 'openai') {
    return {
      ...options,
      providerOptions: {
        ...options.providerOptions,
        openai: { ...options.providerOptions?.openai, store: false },
      },
    };
  }
  if (provider === 'bedrock')
    return { ...options, prompt: maskPersonalDataInPrompt(options.prompt) };
  return options;
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
  tier: AITier,
  usage: LanguageModelV3Usage | undefined,
  now: Date
) {
  try {
    await dependencies.record({
      provider: attempt.provider,
      tier,
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
  else if (skipped.includes('CIRCUIT_OPEN')) reason = 'CIRCUIT_OPEN';
  else if (skipped.includes('CAPPED') || skipped.includes('SPEND_UNKNOWN')) reason = 'CAPPED';
  else reason = 'NOT_CONFIGURED';
  return new AIUnavailableError(reason, 'AI is currently unavailable.', {
    cause: failures.at(-1)?.error,
  });
}

function logFailure(provider: Provider, failure: ProviderFailure, next: 'retry' | 'next' | 'stop') {
  const policy = FAILURE_POLICY[failure.kind];
  const log = policy.alert === 'none' ? console.warn : console.error;
  // Kind and status only: provider messages can echo request content.
  log('[ai-router] provider attempt failed', {
    provider,
    kind: failure.kind,
    status: failure.status,
    next,
  });
}

async function plan(context: RoutedCallContext): Promise<Planned> {
  const env = context.env ?? process.env;
  const now = dependencies.now();
  const settings = await readRoutingSettings(env, now);
  if (settings.mode === 'Disabled') {
    throw new AIUnavailableError('DISABLED', 'AI is disabled by the platform routing policy.');
  }
  const deepStrategyEnabled =
    needsDeepStrategyOptIn(context.feature, context.tier) && context.organizationId
      ? await deepStrategyEnabledCached(context.organizationId, now)
      : false;
  const workload = resolveWorkload({
    feature: context.feature,
    tier: context.tier,
    deepStrategyEnabled,
    env,
  });
  return { env, now, settings, workload, chain: workloadChain(settings, workload, env) };
}

function callerAborted(context: RoutedCallContext, options: LanguageModelV3CallOptions) {
  return Boolean(options.abortSignal?.aborted || (context.turn && remainingMs(context.turn) <= 0));
}

function turnLimit(cause?: unknown) {
  return new AIUnavailableError('TURN_LIMIT', 'This turn has no model calls or time left.', {
    cause,
  });
}

/**
 * Run one call through the chain. For each provider: one attempt, and one jittered
 * retry for a transient failure; an availability failure then hands over to the next
 * provider. Anything else (a bad request, a refusal, an unusable response, the
 * caller's abort) is thrown as is. Every attempt, retries included, spends one model
 * call from the turn.
 */
async function runChain<T>(
  planned: Planned,
  context: RoutedCallContext,
  options: LanguageModelV3CallOptions,
  run: (attempt: Attempt, options: LanguageModelV3CallOptions) => PromiseLike<T>
): Promise<{ attempt: Attempt; value: T }> {
  const skipped: SkipReason[] = [];
  const failures: Failure[] = [];
  for (const provider of planned.chain) {
    const attempt = await prepareAttempt(provider, planned);
    if ('skip' in attempt) {
      skipped.push(attempt.skip);
      continue;
    }
    const callOptions = callOptionsFor(provider, options);
    for (let retry = 0; ; retry++) {
      if (context.turn && !claimModelCall(context.turn)) {
        // The probe (if this was one) never reached the provider.
        recordCircuit(provider, 'release', dependencies.now().getTime());
        throw turnLimit(failures.at(-1)?.error);
      }
      try {
        const value = await run(attempt, callOptions);
        recordCircuit(provider, 'success', dependencies.now().getTime());
        return { attempt, value };
      } catch (error) {
        const now = dependencies.now();
        const failure = classifyProviderError(error, {
          callerAborted: callerAborted(context, options),
          now: now.getTime(),
        });
        const policy = FAILURE_POLICY[failure.kind];
        if (failure.kind === 'abort') {
          recordCircuit(provider, 'release', now.getTime());
          throw error;
        }
        // The provider answered: it is up, the request or the answer is the problem.
        recordCircuit(
          provider,
          policy.circuit === 'none' ? 'success' : policy.circuit,
          now.getTime()
        );
        if (!policy.failover) throw error;
        if (policy.alert === 'notify') alertAuthFailure(provider, now);

        const delay = retry === 0 ? retryDelayMs(failure, dependencies.random) : null;
        const fits =
          delay !== null &&
          !circuitIsOpen(provider, now.getTime()) &&
          (!context.turn || remainingMs(context.turn) > delay);
        if (fits) {
          logFailure(provider, failure, 'retry');
          await dependencies.sleep(delay, options.abortSignal);
          if (callerAborted(context, options)) throw error;
          continue;
        }
        logFailure(provider, failure, planned.chain.at(-1) === provider ? 'stop' : 'next');
        failures.push({ provider, error });
        break;
      }
    }
  }
  throw exhausted(skipped, failures);
}

const routingMetadata = (attempt: Attempt) => ({
  devfathomRouting: { provider: attempt.provider, modelId: attempt.modelId },
});

type AnswerShape = { hasText: boolean; hasToolCall: boolean; finish: LanguageModelV3FinishReason };

/**
 * A cheap-tier answer from the small model is resent once on the standard model when
 * it is empty (no text and no tool call) or cut off. A refusal is never resent.
 */
function shouldEscalate(planned: Planned, attempt: Attempt, answer: AnswerShape): boolean {
  if (!planned.workload.escalateToStandard || planned.workload.tier !== 'cheap') return false;
  if (attempt.modelId === planned.settings.models[attempt.provider].standard) return false;
  if (answer.finish.unified === 'content-filter') return false;
  return answer.finish.unified === 'length' || (!answer.hasText && !answer.hasToolCall);
}

function escalationContext(context: RoutedCallContext): RoutedCallContext {
  return { ...context, tier: 'standard' };
}

function keepCheapAnswer(
  error: unknown,
  context: RoutedCallContext,
  options: LanguageModelV3CallOptions
) {
  if (callerAborted(context, options)) throw error;
  console.warn(
    '[ai-router] escalation to the standard model failed; keeping the small-model answer',
    {
      error: errorName(error),
      reason: error instanceof AIUnavailableError ? error.reason : undefined,
    }
  );
}

/**
 * One complete call through the chain. A provider that is unconfigured, at its cap
 * or behind an open circuit is skipped; an availability failure hands over to the
 * next. Cancellation, refusals and bad requests are never retried elsewhere.
 */
export async function routedGenerate(
  context: RoutedCallContext,
  options: LanguageModelV3CallOptions
): Promise<LanguageModelV3GenerateResult> {
  const planned = await plan(context);
  const { attempt, value: result } = await runChain(planned, context, options, (chosen, call) =>
    chosen.model.doGenerate(call)
  );
  await recordAttempt(attempt, context, planned.workload.tier, result.usage, planned.now);
  const answer: LanguageModelV3GenerateResult = {
    ...result,
    providerMetadata: { ...result.providerMetadata, ...routingMetadata(attempt) },
  };
  const shape: AnswerShape = {
    hasText: result.content.some((part) => part.type === 'text' && part.text.trim() !== ''),
    hasToolCall: result.content.some((part) => part.type === 'tool-call'),
    finish: result.finishReason,
  };
  if (!shouldEscalate(planned, attempt, shape)) return answer;
  try {
    return await routedGenerate(escalationContext(context), options);
  } catch (error) {
    keepCheapAnswer(error, context, options);
    return answer;
  }
}

function meter(
  stream: ReadableStream<LanguageModelV3StreamPart>,
  attempt: Attempt,
  context: RoutedCallContext,
  planned: Planned,
  alreadyRecorded = false
) {
  return stream.pipeThrough(
    new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
      async transform(part, controller) {
        if (part.type === 'finish') {
          if (!alreadyRecorded) {
            await recordAttempt(attempt, context, planned.workload.tier, part.usage, planned.now);
          }
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
}

async function bufferStream(stream: ReadableStream<LanguageModelV3StreamPart>) {
  const parts: LanguageModelV3StreamPart[] = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
  } catch (error) {
    parts.push({ type: 'error', error });
  } finally {
    reader.releaseLock();
  }
  return parts;
}

function replay(parts: LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

/**
 * Streaming through the chain. Failover is only possible before the stream is
 * returned (connection, auth, rate limit and 5xx all fail there); once bytes
 * flow, an error belongs to that provider's stream.
 *
 * A cheap-tier stream from the small model is read to the end inside the router
 * first, so an empty or cut-off answer can be resent on the standard model before
 * the caller sees anything.
 */
export async function routedStream(
  context: RoutedCallContext,
  options: LanguageModelV3CallOptions
): Promise<LanguageModelV3StreamResult> {
  const planned = await plan(context);
  const { attempt, value: result } = await runChain(planned, context, options, (chosen, call) =>
    chosen.model.doStream(call)
  );
  const mayEscalate =
    planned.workload.escalateToStandard &&
    planned.workload.tier === 'cheap' &&
    attempt.modelId !== planned.settings.models[attempt.provider].standard;
  if (!mayEscalate) return { ...result, stream: meter(result.stream, attempt, context, planned) };

  const parts = await bufferStream(result.stream);
  const finish = parts.find((part) => part.type === 'finish');
  const failed = parts.some((part) => part.type === 'error');
  const shape: AnswerShape = {
    hasText: parts.some((part) => part.type === 'text-delta' && part.delta.trim() !== ''),
    hasToolCall: parts.some((part) => part.type === 'tool-call'),
    finish: finish?.finishReason ?? { unified: 'other', raw: undefined },
  };
  if (failed || !finish || !shouldEscalate(planned, attempt, shape)) {
    return { ...result, stream: meter(replay(parts), attempt, context, planned) };
  }
  await recordAttempt(attempt, context, planned.workload.tier, finish.usage, planned.now);
  try {
    return await routedStream(escalationContext(context), options);
  } catch (error) {
    keepCheapAnswer(error, context, options);
    return { ...result, stream: meter(replay(parts), attempt, context, planned, true) };
  }
}

/**
 * Whether a routed call could be attempted right now: not disabled by the
 * SuperAdmin switch, and some candidate is configured, under its cap and not behind
 * an open circuit. Lets a route answer with its unavailable state before it starts
 * streaming.
 */
export async function readRoutedAvailability(
  env: Env = process.env
): Promise<{ available: true } | { available: false; reason: AIUnavailableReason }> {
  const now = dependencies.now();
  const settings = await readRoutingSettings(env, now);
  if (settings.mode === 'Disabled') return { available: false, reason: 'DISABLED' };
  const bounds = karachiMonthBounds(now);
  let sawCap = false;
  let sawOpenCircuit = false;
  for (const provider of candidateChain(settings, env)) {
    if (!isRoutedProviderConfigured(provider, env)) continue;
    if (!circuitWouldAdmit(provider, now.getTime())) {
      sawOpenCircuit = true;
      continue;
    }
    try {
      if (
        (await dependencies.spend(provider, bounds.from, bounds.to)) < settings.capsUsd[provider]
      ) {
        return { available: true };
      }
    } catch {
      // Unknown spend is treated as capped, as in prepareAttempt.
    }
    sawCap = true;
  }
  return {
    available: false,
    reason: sawOpenCircuit ? 'CIRCUIT_OPEN' : sawCap ? 'CAPPED' : 'NOT_CONFIGURED',
  };
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
    // The router owns retries (one jittered retry, then failover); SDK retries stay off.
    maxRetries: settings.maxRetries ?? 0,
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
  deepStrategyCache.clear();
  circuits.clear();
  authAlertHours.clear();
}
