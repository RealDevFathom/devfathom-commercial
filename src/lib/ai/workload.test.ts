import { describe, expect, it } from 'vitest';

import {
  WEEKLY_SUMMARY_RETRY_DELAYS_MS,
  needsDeepStrategyOptIn,
  nextWeeklySummaryAttemptAt,
  resolveWorkload,
} from './workload';

const off = { AF_HAIKU_LOOKUPS: 'false' };
const on = { AF_HAIKU_LOOKUPS: 'true' };

describe('workload policy', () => {
  it('keeps the cheap tier on the standard model unless AF_HAIKU_LOOKUPS=true', () => {
    expect(
      resolveWorkload({
        feature: 'ask-fathom',
        tier: 'cheap',
        deepStrategyEnabled: false,
        env: off,
      })
    ).toEqual({
      requestedTier: 'cheap',
      tier: 'standard',
      providers: null,
      failover: true,
      escalateToStandard: false,
    });
    expect(
      resolveWorkload({ feature: 'ask-fathom', tier: 'cheap', deepStrategyEnabled: false, env: {} })
        .tier
    ).toBe('standard');
    expect(
      resolveWorkload({ feature: 'ask-fathom', tier: 'cheap', deepStrategyEnabled: false, env: on })
    ).toMatchObject({ tier: 'cheap', escalateToStandard: true, failover: true });
  });

  it('uses the deep model only for an opted-in organization', () => {
    const base = { feature: 'periodic-owner-reports', tier: 'deep' as const, env: off };
    expect(resolveWorkload({ ...base, deepStrategyEnabled: false }).tier).toBe('standard');
    expect(resolveWorkload({ ...base, deepStrategyEnabled: true }).tier).toBe('deep');
    expect(needsDeepStrategyOptIn('periodic-owner-reports', 'deep')).toBe(true);
    expect(needsDeepStrategyOptIn('ask-fathom', 'standard')).toBe(false);
  });

  it('always writes the weekly owner summary on the deep model, Anthropic only, no failover', () => {
    for (const deepStrategyEnabled of [false, true]) {
      expect(
        resolveWorkload({
          feature: 'weekly-owner-summary',
          tier: 'deep',
          deepStrategyEnabled,
          env: on,
        })
      ).toEqual({
        requestedTier: 'deep',
        tier: 'deep',
        providers: ['anthropic'],
        failover: false,
        escalateToStandard: false,
      });
    }
    expect(needsDeepStrategyOptIn('weekly-owner-summary', 'deep')).toBe(false);
  });

  it('keeps the standard tier as it is', () => {
    expect(
      resolveWorkload({ feature: 'growth', tier: 'standard', deepStrategyEnabled: true, env: on })
    ).toMatchObject({ tier: 'standard', escalateToStandard: false, failover: true });
  });
});

describe('weekly summary retries', () => {
  it('retries at +15 min, +1 h and +6 h, then gives up', () => {
    expect(WEEKLY_SUMMARY_RETRY_DELAYS_MS).toEqual([900_000, 3_600_000, 21_600_000]);
    const failedAt = new Date('2026-11-02T03:00:00Z');
    expect(nextWeeklySummaryAttemptAt(1, failedAt)).toEqual(new Date('2026-11-02T03:15:00Z'));
    expect(nextWeeklySummaryAttemptAt(2, failedAt)).toEqual(new Date('2026-11-02T04:00:00Z'));
    expect(nextWeeklySummaryAttemptAt(3, failedAt)).toEqual(new Date('2026-11-02T09:00:00Z'));
    expect(nextWeeklySummaryAttemptAt(4, failedAt)).toBeNull();
    expect(nextWeeklySummaryAttemptAt(0, failedAt)).toBeNull();
  });
});
