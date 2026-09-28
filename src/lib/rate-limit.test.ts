import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearRateLimit, rateLimit } from '@/lib/rate-limit';

describe('clearRateLimit', () => {
  it('restores a consumed bucket after a successful protected operation', () => {
    const key = `test:successful-login:${crypto.randomUUID()}`;

    expect(rateLimit(key, 1, 60_000).ok).toBe(true);
    expect(rateLimit(key, 1, 60_000).ok).toBe(false);

    clearRateLimit(key);

    expect(rateLimit(key, 1, 60_000).ok).toBe(true);
  });

  it('does not alter a different credential bucket', () => {
    const prefix = `test:credential-isolation:${crypto.randomUUID()}`;
    const firstKey = `${prefix}:first`;
    const secondKey = `${prefix}:second`;

    expect(rateLimit(firstKey, 1, 60_000).ok).toBe(true);
    expect(rateLimit(secondKey, 1, 60_000).ok).toBe(true);

    clearRateLimit(firstKey);

    expect(rateLimit(firstKey, 1, 60_000).ok).toBe(true);
    expect(rateLimit(secondKey, 1, 60_000).ok).toBe(false);
  });
});

describe('restaurant integrated flood-limit opt-in', () => {
  afterEach(() => vi.unstubAllEnvs());

  function environment(
    nodeEnv: string | undefined,
    lane: string | undefined,
    flag: string | undefined
  ) {
    vi.stubEnv('NODE_ENV', nodeEnv);
    vi.stubEnv('RESTAURANT_INTEGRATED_E2E', lane);
    vi.stubEnv('RESTAURANT_E2E_RELAX_TERMINAL_FLOOD_LIMITS', flag);
  }

  it.each([
    ['production', '1', '1'],
    ['development', '1', '1'],
    [undefined, '1', '1'],
    ['test', undefined, '1'],
    ['test', '1', undefined],
    ['test', '1', '0'],
  ])('still throttles with NODE_ENV=%s, lane=%s, opt-in=%s', (nodeEnv, lane, flag) => {
    environment(nodeEnv, lane, flag);
    for (const prefix of ['terminal:ip:', 'terminal:device:']) {
      const key = `${prefix}${crypto.randomUUID()}`;
      expect(rateLimit(key, 1, 60_000).ok).toBe(true);
      expect(rateLimit(key, 1, 60_000)).toMatchObject({ ok: false, remaining: 0 });
    }
  });

  it('allows repeated synthetic terminal flood traffic only in the opted-in test lane', () => {
    environment('test', '1', '1');
    for (const prefix of ['terminal:ip:', 'terminal:device:']) {
      const key = `${prefix}${crypto.randomUUID()}`;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(rateLimit(key, 1, 60_000)).toMatchObject({ ok: true, retryAfter: 0 });
      }
    }
  });

  it('preserves credential and non-terminal throttles even in the opted-in test lane', () => {
    environment('test', '1', '1');
    for (const prefix of ['terminal:cred:', 'login:', 'api:']) {
      const key = `${prefix}${crypto.randomUUID()}`;
      expect(rateLimit(key, 1, 60_000).ok).toBe(true);
      expect(rateLimit(key, 1, 60_000).ok).toBe(false);
    }
  });
});
