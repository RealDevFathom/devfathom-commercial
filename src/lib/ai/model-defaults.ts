import type { AITier } from './tiers';

/**
 * Providers that take part in routing, in the default fallback order. Azure is a
 * legacy, explicit-only selector (AI_PROVIDER=azure) and is deliberately absent:
 * it is never a default and never part of the fallback chain.
 */
export const ROUTED_AI_PROVIDERS = ['anthropic', 'openai', 'bedrock'] as const;
export type TieredAIProviderName = (typeof ROUTED_AI_PROVIDERS)[number];
export type AIModelOverrides = Partial<Record<AITier, string>>;
export const AI_TIERS = ['cheap', 'standard', 'deep'] as const satisfies readonly AITier[];

type Env = Record<string, string | undefined>;

export function isRoutedProvider(value: unknown): value is TieredAIProviderName {
  return typeof value === 'string' && (ROUTED_AI_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Model per provider and tier. Bedrock uses the global cross-Region inference
 * profiles, called from ap-southeast-1.
 *
 * The table is what each tier would use; the router decides which tier a call
 * really runs on (src/lib/ai/workload.ts): `cheap` runs on the standard model
 * unless AF_HAIKU_LOOKUPS=true, and `deep` runs on the standard model unless the
 * call is the weekly owner summary or the organization opted in to deep strategy.
 * Bedrock is never given a 4.x model by default.
 */
export const DEFAULT_MODELS = {
  anthropic: {
    cheap: 'claude-haiku-5-5',
    standard: 'claude-sonnet-5-5',
    deep: 'claude-opus-5-5',
  },
  openai: {
    cheap: 'gpt-6-luna',
    standard: 'gpt-6.1-sol',
    deep: 'gpt-6.1-sol',
  },
  bedrock: {
    cheap: 'global.anthropic.claude-haiku-5-5',
    standard: 'global.anthropic.claude-sonnet-5-5',
    deep: 'global.anthropic.claude-sonnet-5-5',
  },
} as const satisfies Record<TieredAIProviderName, Record<AITier, string>>;

/** `AF_HAIKU_LOOKUPS=true` lets the cheap tier use the small model; anything else keeps it on standard. */
export function haikuLookupsEnabled(env: Env = process.env): boolean {
  return env.AF_HAIKU_LOOKUPS?.trim().toLowerCase() === 'true';
}

export const DEFAULT_PROVIDER_ORDER: readonly TieredAIProviderName[] = ROUTED_AI_PROVIDERS;

/** Server-side monthly spend caps (USD, Asia/Karachi calendar month). */
export const DEFAULT_MONTHLY_CAPS_USD: Readonly<Record<TieredAIProviderName, number>> = {
  anthropic: 190,
  openai: 190,
  bedrock: 300,
};

/** Bedrock source Region. BEDROCK_REGION must still be set for Bedrock to join the chain. */
export const DEFAULT_BEDROCK_REGION = 'ap-southeast-1';
export const DEFAULT_AI_SECRETS_REGION = 'ap-southeast-1';

/**
 * List prices in USD per million tokens, used when no `ai_model_prices` row
 * exists. Bedrock global profiles are billed at the first-party price, with no
 * Regional premium. A SUPER_ADMIN price row always wins.
 */
export const DEFAULT_MODEL_PRICES_USD_PER_MTOK: Readonly<
  Record<string, { input: number; output: number }>
> = {
  'anthropic:claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'anthropic:claude-sonnet-5-5': { input: 2, output: 10 },
  'anthropic:claude-opus-5-5': { input: 4, output: 20 },
  'openai:gpt-6-luna': { input: 0.1, output: 0.5 },
  'openai:gpt-6.1-sol': { input: 2, output: 10 },
  'bedrock:global.anthropic.claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'bedrock:global.anthropic.claude-sonnet-5-5': { input: 2, output: 10 },
  'bedrock:global.anthropic.claude-opus-5-5': { input: 4, output: 20 },
};

/**
 * Deliberately high rates for a model with neither a price row nor a list price,
 * so an unknown model can only make a cap trip early, never late.
 */
export const FALLBACK_PRICE_USD_PER_MTOK: Readonly<
  Record<TieredAIProviderName, { input: number; output: number }>
> = {
  anthropic: { input: 15, output: 75 },
  openai: { input: 15, output: 75 },
  bedrock: { input: 16.5, output: 82.5 },
};

export function listPriceFor(provider: TieredAIProviderName, model: string) {
  return (
    DEFAULT_MODEL_PRICES_USD_PER_MTOK[`${provider}:${model}`] ??
    FALLBACK_PRICE_USD_PER_MTOK[provider]
  );
}

/** `AI_<PROVIDER>_MODEL_<TIER>`, e.g. AI_OPENAI_MODEL_STANDARD. */
export function modelEnvName(provider: TieredAIProviderName, tier: AITier): string {
  return `AI_${provider.toUpperCase()}_MODEL_${tier.toUpperCase()}`;
}

/** `AI_<PROVIDER>_MONTHLY_CAP_USD`, e.g. AI_BEDROCK_MONTHLY_CAP_USD. */
export function capEnvName(provider: TieredAIProviderName): string {
  return `AI_${provider.toUpperCase()}_MONTHLY_CAP_USD`;
}

/** Precedence: explicit override (SuperAdmin), then environment, then code default. */
export function getDefaultModelId(
  provider: TieredAIProviderName,
  tier: AITier,
  overrides?: AIModelOverrides,
  env: Env = process.env
): string {
  return (
    overrides?.[tier]?.trim() ||
    env[modelEnvName(provider, tier)]?.trim() ||
    DEFAULT_MODELS[provider][tier]
  );
}

/** A malformed or negative cap falls back to the default rather than lifting the cap. */
export function envMonthlyCapUsd(provider: TieredAIProviderName, env: Env = process.env): number {
  const raw = env[capEnvName(provider)]?.trim();
  if (!raw) return DEFAULT_MONTHLY_CAPS_USD[provider];
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MONTHLY_CAPS_USD[provider];
}

/** AI_PROVIDER_ORDER, e.g. "anthropic,openai,bedrock". Unknown or repeated names are dropped. */
export function envProviderOrder(env: Env = process.env): TieredAIProviderName[] {
  const raw = env.AI_PROVIDER_ORDER?.trim();
  if (!raw) return [...DEFAULT_PROVIDER_ORDER];
  const order: TieredAIProviderName[] = [];
  for (const name of raw.split(',').map((part) => part.trim().toLowerCase())) {
    if (isRoutedProvider(name) && !order.includes(name)) order.push(name);
  }
  return order.length ? order : [...DEFAULT_PROVIDER_ORDER];
}

export function bedrockRegion(env: Env = process.env): string {
  return env.BEDROCK_REGION?.trim() || env.AI_BEDROCK_REGION?.trim() || DEFAULT_BEDROCK_REGION;
}
