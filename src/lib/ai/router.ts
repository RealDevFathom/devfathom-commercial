import 'server-only';

import { getModelForTier, AIUnavailableError, type AIModelSelection } from './provider';
import type { TieredAIProviderName } from './model-defaults';
import type { AITier } from './tiers';
import {
  readAIRoutingSettings,
  readProviderSpend,
  recordAIUsage,
  type AIRoutingSettings,
  type UsageWrite,
} from './spend';

export type AITokenUsage = { inputTokens?: number; outputTokens?: number };
export type RoutedResult<T> = { value: T; usage?: AITokenUsage };
export type AIRouterDependencies = {
  now: () => Date;
  settings: () => Promise<AIRoutingSettings | null>;
  spend: typeof readProviderSpend;
  model: (provider: TieredAIProviderName, tier: AITier, settings: AIRoutingSettings) => AIModelSelection;
  record: (usage: UsageWrite) => Promise<unknown>;
};

let settingsCache: { expiresAt: number; value: AIRoutingSettings | null } | undefined;
const SETTINGS_CACHE_MS = 30_000;

async function cachedSettings(now: Date) {
  if (settingsCache && settingsCache.expiresAt > now.getTime()) return settingsCache.value;
  const value = await readAIRoutingSettings();
  settingsCache = { value, expiresAt: now.getTime() + SETTINGS_CACHE_MS };
  return value;
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

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  const status = candidate.status ?? candidate.statusCode ?? candidate.response?.status;
  return typeof status === 'number' ? status : undefined;
}

export function isAnthropicFailoverError(error: unknown): boolean {
  const status = statusOf(error);
  if (status === 429 || (status !== undefined && status >= 500 && status <= 599)) return true;
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; type?: unknown; message?: unknown };
  const haystack = `${candidate.code ?? ''} ${candidate.type ?? ''} ${candidate.message ?? ''}`.toLowerCase();
  return /credit|billing|insufficient[_ -]?funds|payment[_ -]?required/.test(haystack);
}

function tokens(usage?: AITokenUsage) {
  return { inputTokens: Math.max(0, usage?.inputTokens ?? 0), outputTokens: Math.max(0, usage?.outputTokens ?? 0) };
}

function errorUsage(error: unknown): AITokenUsage | undefined {
  return error && typeof error === 'object' ? (error as { usage?: AITokenUsage }).usage : undefined;
}

const defaultDependencies: AIRouterDependencies = {
  now: () => new Date(),
  settings: async () => cachedSettings(new Date()),
  spend: readProviderSpend,
  model: (provider, tier, settings) => {
    const modelId = settings.models[provider][tier];
    return { model: getModelForTier(provider, tier, { [tier]: modelId }), provider, modelId };
  },
  record: recordAIUsage,
};

export type RouteAIOptions<T> = {
  tier: AITier;
  feature: string;
  organizationId?: string | null;
  execute: (selection: AIModelSelection) => Promise<RoutedResult<T>>;
  dependencies?: AIRouterDependencies;
};

/** Routes one complete, non-streaming call and accounts for every known billed attempt. */
export async function routeAI<T>(options: RouteAIOptions<T>): Promise<T> {
  const deps = options.dependencies ?? defaultDependencies;
  const now = deps.now();
  const settings = await deps.settings();
  if (!settings) {
    throw new AIUnavailableError(
      'NOT_CONFIGURED',
      'AI routing is not configured for this platform.'
    );
  }
  if (settings.mode === 'Disabled') {
    throw new AIUnavailableError('DISABLED', 'AI is disabled by the platform routing policy.');
  }
  const bounds = karachiMonthBounds(now);
  let provider: TieredAIProviderName;
  if (settings.mode === 'ForceAnthropic') provider = 'anthropic';
  else if (settings.mode === 'ForceBedrock') provider = 'bedrock';
  else provider = (await deps.spend('anthropic', bounds.from, bounds.to)) >= settings.monthlyAnthropicBudgetUsd ? 'bedrock' : 'anthropic';

  const attempt = async (selectedProvider: TieredAIProviderName) => {
    const selection = deps.model(selectedProvider, options.tier, settings);
    try {
      const result = await options.execute(selection);
      await deps.record({ provider: selectedProvider, tier: options.tier, model: selection.modelId, feature: options.feature, organizationId: options.organizationId, ...tokens(result.usage), createdAt: now });
      return result.value;
    } catch (error) {
      const usage = errorUsage(error);
      if (usage) await deps.record({ provider: selectedProvider, tier: options.tier, model: selection.modelId, feature: options.feature, organizationId: options.organizationId, ...tokens(usage), createdAt: now });
      throw error;
    }
  };

  try {
    return await attempt(provider);
  } catch (error) {
    if (settings.mode === 'Auto' && provider === 'anthropic' && isAnthropicFailoverError(error)) return attempt('bedrock');
    throw error;
  }
}

export function __resetAIRouterCacheForTests() { settingsCache = undefined; }
