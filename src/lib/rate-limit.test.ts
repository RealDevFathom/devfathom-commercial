import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearRateLimit,
  assertProductionClientIpConfig,
  assertProductionRateLimitHmacSecret,
  clientIp,
  interpretRateLimitRow,
  RATE_LIMIT_UPSERT_SQL,
  rateLimit,
  rateLimitBackend,
  rateLimitStorageKey,
  rateLimitQuery,
} from '@/lib/rate-limit';

describe('clearRateLimit', () => {
  it('restores a consumed bucket after a successful protected operation', async () => {
    const key = `test:successful-login:${crypto.randomUUID()}`;

    expect((await rateLimit(key, 1, 60_000)).ok).toBe(true);
    expect((await rateLimit(key, 1, 60_000)).ok).toBe(false);

    await clearRateLimit(key);

    expect((await rateLimit(key, 1, 60_000)).ok).toBe(true);
  });

  it('does not alter a different credential bucket', async () => {
    const prefix = `test:credential-isolation:${crypto.randomUUID()}`;
    const firstKey = `${prefix}:first`;
    const secondKey = `${prefix}:second`;

    expect((await rateLimit(firstKey, 1, 60_000)).ok).toBe(true);
    expect((await rateLimit(secondKey, 1, 60_000)).ok).toBe(true);

    await clearRateLimit(firstKey);

    expect((await rateLimit(firstKey, 1, 60_000)).ok).toBe(true);
    expect((await rateLimit(secondKey, 1, 60_000)).ok).toBe(false);
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
    vi.stubEnv('RATE_LIMIT_HMAC_SECRET', 'rate-limit-test-secret');
  }

  it.each([
    ['production', '1', '1'],
    ['development', '1', '1'],
    [undefined, '1', '1'],
    ['test', undefined, '1'],
    ['test', '1', undefined],
    ['test', '1', '0'],
  ])('still throttles with NODE_ENV=%s, lane=%s, opt-in=%s', async (nodeEnv, lane, flag) => {
    environment(nodeEnv, lane, flag);
    for (const prefix of ['terminal:ip:', 'terminal:device:']) {
      const key = `${prefix}${crypto.randomUUID()}`;
      expect((await rateLimit(key, 1, 60_000)).ok).toBe(true);
      expect(await rateLimit(key, 1, 60_000)).toMatchObject({ ok: false, remaining: 0 });
    }
  });

  it('allows repeated synthetic terminal flood traffic only in the opted-in test lane', async () => {
    environment('test', '1', '1');
    for (const prefix of ['terminal:ip:', 'terminal:device:']) {
      const key = `${prefix}${crypto.randomUUID()}`;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(await rateLimit(key, 1, 60_000)).toMatchObject({ ok: true, retryAfter: 0 });
      }
    }
  });

  it('preserves credential and non-terminal throttles even in the opted-in test lane', async () => {
    environment('test', '1', '1');
    for (const prefix of ['terminal:cred:', 'login:', 'api:']) {
      const key = `${prefix}${crypto.randomUUID()}`;
      expect((await rateLimit(key, 1, 60_000)).ok).toBe(true);
      expect((await rateLimit(key, 1, 60_000)).ok).toBe(false);
    }
  });
});

describe('shared rate-limit store', () => {
  afterEach(() => {
    rateLimitQuery.current = null;
    vi.unstubAllEnvs();
  });

  it('uses postgres outside tests and memory inside vitest', () => {
    expect(rateLimitBackend({ NODE_ENV: 'production' })).toBe('postgres');
    expect(rateLimitBackend({ NODE_ENV: 'production', RATE_LIMIT_STORE: 'memory' })).toBe(
      'postgres'
    );
    expect(rateLimitBackend({ NODE_ENV: 'test', VITEST: 'true' })).toBe('memory');
    expect(rateLimitBackend({ NODE_ENV: 'test', RATE_LIMIT_STORE: 'postgres' })).toBe('postgres');
  });

  it('shares a fixed window across two callers of one postgres store', async () => {
    vi.stubEnv('RATE_LIMIT_STORE', 'postgres');
    const rows = new Map<string, { count: number; resetAt: Date }>();
    rateLimitQuery.current = async (sql, params) => {
      if (sql.includes('DELETE') && !sql.includes('RETURNING')) {
        rows.delete(String(params[0]));
        return [];
      }
      const key = String(params[0]);
      const windowMs = Number(params[1]);
      const limit = Number(params[2]);
      const now = new Date();
      const current = rows.get(key);
      let count = 1;
      let resetAt = new Date(now.getTime() + windowMs);
      if (current && current.resetAt > now) {
        count = current.count >= limit ? limit + 1 : current.count + 1;
        resetAt = current.resetAt;
      }
      rows.set(key, { count, resetAt });
      return [{ count, resetAt }];
    };

    const key = `shared:${crypto.randomUUID()}`;
    expect((await rateLimit(key, 1, 60_000)).ok).toBe(true);
    expect((await rateLimit(key, 1, 60_000)).ok).toBe(false);
    expect(RATE_LIMIT_UPSERT_SQL).toContain('ON CONFLICT');
    expect(RATE_LIMIT_UPSERT_SQL).not.toContain('${');
  });

  it('stores an HMAC instead of a raw address or email', async () => {
    vi.stubEnv('RATE_LIMIT_STORE', 'postgres');
    const seen: string[] = [];
    rateLimitQuery.current = async (_sql, params) => {
      seen.push(String(params[0]));
      return [{ count: 1, resetAt: new Date(Date.now() + 60_000) }];
    };
    const raw = 'login:acct:person@example.com';
    await rateLimit(raw, 5, 60_000);
    await clearRateLimit(raw);
    expect(seen[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(seen[0]).not.toContain('person@example.com');
    expect(seen[1]).toBe(seen[0]);
  });

  it('fails closed when the shared store errors', async () => {
    vi.stubEnv('RATE_LIMIT_STORE', 'postgres');
    rateLimitQuery.current = async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
    };
    await expect(rateLimit('boom', 5, 60_000)).resolves.toMatchObject({ ok: false, remaining: 0 });
  });

  it('turns a returned row into the same allow/deny shape as the memory window', () => {
    const resetAt = new Date(Date.now() + 5_000);
    expect(interpretRateLimitRow(1, resetAt, 2).ok).toBe(true);
    expect(interpretRateLimitRow(3, resetAt, 2)).toMatchObject({ ok: false, remaining: 0 });
  });
});

describe('assertProductionClientIpConfig', () => {
  it('requires a proxy setting only for a production server', () => {
    expect(() => assertProductionClientIpConfig({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertProductionClientIpConfig({ NODE_ENV: 'test' })).not.toThrow();
    expect(() =>
      assertProductionClientIpConfig({
        NODE_ENV: 'production',
        NEXT_PHASE: 'phase-production-build',
      })
    ).not.toThrow();
    expect(() => assertProductionClientIpConfig({ NODE_ENV: 'production' })).toThrow(/unknown/);
    expect(() =>
      assertProductionClientIpConfig({ NODE_ENV: 'production', CLIENT_IP_HEADER: '   ' })
    ).toThrow(/CLIENT_IP_HEADER/);
  });

  it('accepts any one of the three proxy settings', () => {
    expect(() =>
      assertProductionClientIpConfig({
        NODE_ENV: 'production',
        CLIENT_IP_HEADER: 'cf-connecting-ip',
      })
    ).not.toThrow();
    expect(() =>
      assertProductionClientIpConfig({ NODE_ENV: 'production', TRUSTED_PROXY_CIDRS: '10.0.0.0/8' })
    ).not.toThrow();
    expect(() =>
      assertProductionClientIpConfig({ NODE_ENV: 'production', TRUSTED_PROXY_HOPS: '1' })
    ).not.toThrow();
  });
});

describe('assertProductionRateLimitHmacSecret', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('refuses production startup when neither secret is set', () => {
    expect(() => assertProductionRateLimitHmacSecret({ NODE_ENV: 'production' })).toThrow(
      /RATE_LIMIT_HMAC_SECRET/
    );
    expect(() =>
      assertProductionRateLimitHmacSecret({ NODE_ENV: 'production', RATE_LIMIT_HMAC_SECRET: '   ' })
    ).toThrow(/AUTH_SECRET/);
    expect(() => assertProductionRateLimitHmacSecret({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertProductionRateLimitHmacSecret({ NODE_ENV: 'test' })).not.toThrow();
    expect(() =>
      assertProductionRateLimitHmacSecret({
        NODE_ENV: 'production',
        NEXT_PHASE: 'phase-production-build',
      })
    ).not.toThrow();
  });

  it('accepts either the dedicated HMAC secret or AUTH_SECRET', () => {
    expect(() =>
      assertProductionRateLimitHmacSecret({
        NODE_ENV: 'production',
        RATE_LIMIT_HMAC_SECRET: 'hmac-secret',
      })
    ).not.toThrow();
    expect(() =>
      assertProductionRateLimitHmacSecret({ NODE_ENV: 'production', AUTH_SECRET: 'auth-secret' })
    ).not.toThrow();
  });

  it('keeps a stable non-production key and refuses to sign with a missing production secret', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('RATE_LIMIT_HMAC_SECRET', '');
    vi.stubEnv('AUTH_SECRET', '');
    const first = rateLimitStorageKey('login:acct:person@example.com');
    const second = rateLimitStorageKey('login:acct:person@example.com');
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toContain('person@example.com');

    vi.stubEnv('RATE_LIMIT_HMAC_SECRET', 'secret-a');
    const signedA = rateLimitStorageKey('login:acct:person@example.com');
    vi.stubEnv('RATE_LIMIT_HMAC_SECRET', 'secret-b');
    const signedB = rateLimitStorageKey('login:acct:person@example.com');
    expect(signedA).not.toBe(signedB);

    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('RATE_LIMIT_HMAC_SECRET', '');
    vi.stubEnv('AUTH_SECRET', '');
    expect(() => rateLimitStorageKey('login:acct:person@example.com')).toThrow(
      /RATE_LIMIT_HMAC_SECRET/
    );
  });
});

describe('clientIp', () => {
  function request(headers: Record<string, string>) {
    return new Request('http://app.example', { headers });
  }

  it('ignores a client-supplied forwarding header when no proxy is trusted', () => {
    const req = request({ 'x-forwarded-for': '1.2.3.4, 10.0.0.8', 'x-real-ip': '1.2.3.4' });
    expect(clientIp(req, {})).toBe('unknown');
    expect(clientIp(req, { NODE_ENV: 'development' })).toBe('unknown');
    expect(clientIp(req, { NODE_ENV: 'production' })).toBe('unknown');
  });

  it('uses one socket-provided address outside production', () => {
    const req = request({ 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '203.0.113.10' });
    expect(clientIp(req, { NODE_ENV: 'development' })).toBe('127.0.0.1');
    expect(clientIp(req, { NODE_ENV: 'test' })).toBe('127.0.0.1');
    expect(clientIp(req, {})).toBe('127.0.0.1');
  });

  it('ignores one forwarded address in production when no proxy is configured', () => {
    const req = request({ 'x-forwarded-for': '127.0.0.1' });
    expect(clientIp(req, { NODE_ENV: 'production' })).toBe('unknown');
  });

  it('uses the rightmost untrusted hop after trusted proxies', () => {
    const req = request({ 'x-forwarded-for': '8.8.8.8, 203.0.113.10, 10.0.0.8' });
    expect(clientIp(req, { TRUSTED_PROXY_CIDRS: '10.0.0.0/8' })).toBe('203.0.113.10');
    expect(clientIp(req, { NODE_ENV: 'production', TRUSTED_PROXY_CIDRS: '10.0.0.0/8' })).toBe(
      '203.0.113.10'
    );
  });

  it('rejects a forwarding list whose closest hop is not a trusted proxy', () => {
    const req = request({ 'x-forwarded-for': '203.0.113.10, 198.51.100.4' });
    expect(clientIp(req, { TRUSTED_PROXY_CIDRS: '10.0.0.0/8' })).toBe('unknown');
  });

  it('selects the hop appended by the configured number of proxies', () => {
    const req = request({ 'x-forwarded-for': '8.8.8.8, 203.0.113.10, 10.0.0.8' });
    expect(clientIp(req, { TRUSTED_PROXY_HOPS: '2' })).toBe('203.0.113.10');
    expect(clientIp(req, { TRUSTED_PROXY_HOPS: '1' })).toBe('10.0.0.8');
  });

  it('prefers a configured header and its rightmost address', () => {
    const req = request({
      'cf-connecting-ip': '203.0.113.9',
      'x-forwarded-for': '8.8.8.8',
      'x-real-ip': '1.1.1.1, 198.51.100.20',
    });
    expect(clientIp(req, { CLIENT_IP_HEADER: 'cf-connecting-ip' })).toBe('203.0.113.9');
    expect(clientIp(req, { CLIENT_IP_HEADER: 'x-real-ip' })).toBe('198.51.100.20');
  });

  it('writes IPv6 in standard form, unwraps IPv4-mapped addresses, and keys IPv6 by /64', () => {
    const env = { NODE_ENV: 'development' as const };
    expect(clientIp(request({ 'x-forwarded-for': '2001:DB8:0:0:1:2:3:4' }), env)).toBe(
      '2001:db8::'
    );
    expect(clientIp(request({ 'x-forwarded-for': '2001:db8::1:2:3:4' }), env)).toBe('2001:db8::');
    expect(clientIp(request({ 'x-forwarded-for': '2001:db8:1:2::aaaa' }), env)).toBe(
      '2001:db8:1:2::'
    );
    expect(clientIp(request({ 'x-forwarded-for': '2001:db8:1:2:ffff:ffff:ffff:ffff' }), env)).toBe(
      '2001:db8:1:2::'
    );
    expect(clientIp(request({ 'x-forwarded-for': '::ffff:203.0.113.10' }), env)).toBe(
      '203.0.113.10'
    );
    expect(clientIp(request({ 'x-forwarded-for': '::FFFF:7f00:1' }), env)).toBe('127.0.0.1');

    const proxied = request({ 'x-forwarded-for': '2001:db8:1:2::5, 2001:db8:9:9::1' });
    expect(clientIp(proxied, { TRUSTED_PROXY_CIDRS: '2001:db8:9:9::1/128' })).toBe(
      '2001:db8:1:2::'
    );
  });
});
