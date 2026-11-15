import { afterEach, describe, expect, it } from 'vitest';

import { proxy } from './proxy';

const ORIGINAL_BASE_DOMAIN = process.env.PLATFORM_BASE_DOMAIN;

afterEach(() => {
  process.env.PLATFORM_BASE_DOMAIN = ORIGINAL_BASE_DOMAIN;
});

function adminRequest(path: string) {
  return new Request(`http://admin.localhost:3000${path}`, {
    headers: { host: 'admin.localhost:3000' },
  });
}

function tenantRequest(path: string) {
  return new Request(`http://acme.localhost:3000${path}`, {
    headers: { host: 'acme.localhost:3000' },
  });
}

function authenticatedTenantRequest(path: string) {
  return new Request(`http://acme.localhost:3000${path}`, {
    headers: {
      host: 'acme.localhost:3000',
      cookie: 'authjs.session-token=opaque-session-token',
    },
  });
}

describe('platform host routing', () => {
  it('sets a unique nonce policy on document requests without unsafe-inline scripts', async () => {
    const first = await proxy(tenantRequest('/login'));
    const second = await proxy(tenantRequest('/login'));
    const firstPolicy = first.headers.get('content-security-policy');
    const secondPolicy = second.headers.get('content-security-policy');

    expect(firstPolicy).toMatch(/script-src 'self' 'nonce-[^']+'/);
    expect(firstPolicy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(secondPolicy).not.toBe(firstPolicy);
  });

  it('never redirects framework assets away from their asset URL', async () => {
    const response = await proxy(adminRequest('/_next/static/chunks/app.js'));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('location')).toBeNull();
  });

  it('keeps the admin host out of tenant pages', async () => {
    const response = await proxy(adminRequest('/dashboard'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://admin.localhost:3000/platform');
  });

  it('keeps platform pages and interactive APIs off tenant hosts', async () => {
    const page = await proxy(tenantRequest('/platform/login'));
    expect(page.status).toBe(307);
    expect(page.headers.get('location')).toBe('http://acme.localhost:3000/dashboard');

    const api = await proxy(tenantRequest('/api/platform/session'));
    expect(api.status).toBe(404);
    await expect(api.json()).resolves.toEqual({ error: 'Not found.' });
  });

  it('allows the bearer-authenticated cron worker on the canonical deployment host', async () => {
    const response = await proxy(tenantRequest('/api/platform/jobs/process'));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('allows unauthenticated POS access without a login redirect', async () => {
    const response = await proxy(tenantRequest('/pos'));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('location')).toBeNull();
  });

  it('allows demo entry and APIs publicly while marking them noindex', async () => {
    for (const path of ['/demo/restaurants', '/demo/restaurants/seats']) {
      const response = await proxy(tenantRequest(path));
      expect(response.status).toBe(200);
      expect(response.headers.get('x-middleware-next')).toBe('1');
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(response.headers.get('location')).toBeNull();
    }
    const unrelated = await proxy(tenantRequest('/demolition'));
    expect(unrelated.status).toBe(307);
  });

  it('allows public occurrence links without exposing authenticated meetings pages', async () => {
    const publicMeeting = await proxy(tenantRequest('/meet/occurrence-public-id'));
    expect(publicMeeting.status).toBe(200);
    expect(publicMeeting.headers.get('x-middleware-next')).toBe('1');
    expect(publicMeeting.headers.get('location')).toBeNull();

    const meetingsWorkspace = await proxy(tenantRequest('/meetings'));
    expect(meetingsWorkspace.status).toBe(307);
    expect(meetingsWorkspace.headers.get('location')).toBe(
      'http://acme.localhost:3000/login?callbackUrl=%2Fmeetings'
    );
  });
});

describe('public paths', () => {
  it('stays public for an entry and every path beneath it', async () => {
    for (const path of [
      '/login',
      '/invite/token-1',
      '/forgot-password',
      '/reset-password/token-1',
      '/sso/complete',
      '/terminal',
      '/pos',
      '/pos/orders',
      '/kds',
      '/meet/occurrence-public-id',
      '/brand',
      '/brand/preview',
      '/wallet',
      '/wallet/join/token-1',
      '/my-pharmacy',
      '/my-pharmacy/join/token-1',
    ]) {
      const response = await proxy(tenantRequest(path));
      expect(response.headers.get('location'), path).toBeNull();
      expect(response.headers.get('x-middleware-next'), path).toBe('1');
    }
  });

  it('sends a longer sibling of a public entry to sign-in, matching whole segments only', async () => {
    for (const path of [
      '/loginx',
      '/invites',
      '/forgot-passwords',
      '/ssox',
      '/terminals',
      '/positions',
      '/possible',
      '/kdsx',
      '/branding',
      '/walletx',
      '/wallets/join',
      '/my-pharmacyx',
    ]) {
      const response = await proxy(tenantRequest(path));
      expect(response.status, path).toBe(307);
      expect(response.headers.get('location'), path).toBe(
        `http://acme.localhost:3000/login?callbackUrl=${encodeURIComponent(path)}`
      );
    }
  });
});

describe('actor-facing tenant URLs', () => {
  it('removes a forbidden cross-tenant organization id before rendering the dashboard', async () => {
    const response = await proxy(
      authenticatedTenantRequest(
        '/dashboard?organizationId=org_restaurant_b_forbidden&view=operations'
      )
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://acme.localhost:3000/dashboard?view=operations'
    );
    expect(response.headers.get('location')).not.toContain('org_restaurant_b_forbidden');
  });

  it('canonicalizes valid tenant navigation without exposing its internal id', async () => {
    const response = await proxy(
      authenticatedTenantRequest('/dashboard?organizationId=org_restaurant_a&view=operations')
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://acme.localhost:3000/dashboard?view=operations'
    );
  });

  it('keeps refresh canonical and cleans a raw-id history revisit again', async () => {
    const canonical = await proxy(authenticatedTenantRequest('/dashboard?view=operations'));
    expect(canonical.status).toBe(200);
    expect(canonical.headers.get('location')).toBeNull();

    const revisited = await proxy(
      authenticatedTenantRequest('/dashboard?organizationId=org_restaurant_a&view=operations')
    );
    expect(revisited.headers.get('location')).toBe(
      'http://acme.localhost:3000/dashboard?view=operations'
    );
  });

  it('does not copy an internal organization id into an unauthenticated login URL', async () => {
    const response = await proxy(tenantRequest('/dashboard?organizationId=org_restaurant_a'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://acme.localhost:3000/dashboard');
    expect([...response.headers]).not.toContainEqual(
      expect.arrayContaining([expect.any(String), expect.stringContaining('org_restaurant_a')])
    );
  });
});

it('preserves query parameters in the signed-out login callback', async () => {
  const response = await proxy(tenantRequest('/pharmacy/counter?lane=1&filter=a%2Bb'));
  const target = new URL(response.headers.get('location')!);
  expect(target.pathname).toBe('/login');
  expect(target.searchParams.get('callbackUrl')).toBe('/pharmacy/counter?lane=1&filter=a%2Bb');
});
