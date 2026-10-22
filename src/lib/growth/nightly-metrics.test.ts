// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { nightlyMetricsAllowed } from './nightly-metrics';

describe('nightly growth settings', () => {
  it('defaults to deny', () => expect(nightlyMetricsAllowed([])).toBe(false));

  it('requires an enabled ALLOW', () => {
    expect(nightlyMetricsAllowed([{ effect: 'ALLOW', nightlyMetricsEnabled: false }])).toBe(false);
    expect(nightlyMetricsAllowed([{ effect: 'ALLOW', nightlyMetricsEnabled: true }])).toBe(true);
  });

  it('lets DENY override enabled ALLOW regardless of ordering', () => {
    const allow = { effect: 'ALLOW' as const, nightlyMetricsEnabled: true };
    const deny = { effect: 'DENY' as const, nightlyMetricsEnabled: false };
    expect(nightlyMetricsAllowed([allow, deny])).toBe(false);
    expect(nightlyMetricsAllowed([deny, allow])).toBe(false);
  });
});
