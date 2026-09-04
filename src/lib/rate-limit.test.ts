import { describe, expect, it } from 'vitest';
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
