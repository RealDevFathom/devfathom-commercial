import { haikuLookupsEnabled, type TieredAIProviderName } from './model-defaults';
import type { AITier } from './tiers';

type Env = Record<string, string | undefined>;

/** The weekly owner summary: written by the deep model, on Anthropic only, never failed over. */
export const WEEKLY_OWNER_SUMMARY_FEATURE = 'weekly-owner-summary';

/**
 * When a failed weekly owner summary is tried again, counted from the failed attempt:
 * +15 min, then +1 h, then +6 h. After the third retry fails the week is given up.
 */
export const WEEKLY_SUMMARY_RETRY_DELAYS_MS = [900_000, 3_600_000, 21_600_000] as const;

/**
 * The next attempt after `failedAttempts` failed attempts (1 = the first try failed),
 * or null when every retry is spent.
 */
export function nextWeeklySummaryAttemptAt(failedAttempts: number, failedAt: Date): Date | null {
  if (!Number.isInteger(failedAttempts) || failedAttempts < 1) return null;
  const delay = WEEKLY_SUMMARY_RETRY_DELAYS_MS[failedAttempts - 1];
  return delay === undefined ? null : new Date(failedAt.getTime() + delay);
}

/** How one routed call runs, decided per call from its feature and tier. */
export type WorkloadPolicy = {
  /** The tier the caller asked for. */
  requestedTier: AITier;
  /** The tier whose model is actually used. */
  tier: AITier;
  /** Only these providers are tried; null means the routing policy's chain. */
  providers: readonly TieredAIProviderName[] | null;
  /** Whether an availability failure hands over to the next provider. */
  failover: boolean;
  /**
   * The cheap tier is on the small model: an empty or cut-off answer is resent once on
   * the standard model. The router also checks the cheap model really differs.
   */
  escalateToStandard: boolean;
};

/** Whether resolving this call needs the organization's deep-strategy opt-in. */
export function needsDeepStrategyOptIn(feature: string, tier: AITier): boolean {
  return tier === 'deep' && feature !== WEEKLY_OWNER_SUMMARY_FEATURE;
}

/**
 * - `cheap` uses the small model only with AF_HAIKU_LOOKUPS=true; otherwise standard.
 * - `deep` uses the deep model for the weekly owner summary (always) or when the
 *   organization opted in to deep strategy; otherwise standard.
 * - The weekly owner summary runs on Anthropic only and never fails over. The
 *   SuperAdmin Disabled switch still stops it (the router checks that first).
 */
export function resolveWorkload(input: {
  feature: string;
  tier: AITier;
  deepStrategyEnabled: boolean;
  env?: Env;
}): WorkloadPolicy {
  const env = input.env ?? process.env;
  if (input.feature === WEEKLY_OWNER_SUMMARY_FEATURE) {
    return {
      requestedTier: input.tier,
      tier: 'deep',
      providers: ['anthropic'],
      failover: false,
      escalateToStandard: false,
    };
  }
  const base = { requestedTier: input.tier, providers: null, failover: true };
  switch (input.tier) {
    case 'cheap':
      return haikuLookupsEnabled(env)
        ? { ...base, tier: 'cheap', escalateToStandard: true }
        : { ...base, tier: 'standard', escalateToStandard: false };
    case 'deep':
      return {
        ...base,
        tier: input.deepStrategyEnabled ? 'deep' : 'standard',
        escalateToStandard: false,
      };
    default:
      return { ...base, tier: 'standard', escalateToStandard: false };
  }
}
