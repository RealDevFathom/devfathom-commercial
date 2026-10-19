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
  it('never redirects framework assets away from their asset URL', () => {
    const response = proxy(adminRequest('/_next/static/chunks/app.js'));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('location')).toBeNull();
  });

  it('keeps the admin host out of tenant pages', () => {
    const response = proxy(adminRequest('/dashboard'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://admin.localhost:3000/platform');
  });

  it('keeps platform pages and interactive APIs off tenant hosts', async () => {
    const page = proxy(tenantRequest('/platform/login'));
    expect(page.status).toBe(307);
    expect(page.headers.get('location')).toBe('http://acme.localhost:3000/dashboard');

    const api = proxy(tenantRequest('/api/platform/session'));
    expect(api.status).toBe(404);
    await expect(api.json()).resolves.toEqual({ error: 'Not found.' });
  });

  it('allows the bearer-authenticated cron worker on the canonical deployment host', () => {
    const response = proxy(tenantRequest('/api/platform/jobs/process'));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('allows unauthenticated POS access without a login redirect', () => {
    const response = proxy(tenantRequest('/pos'));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('location')).toBeNull();
  });

  it('allows public occurrence links without exposing authenticated meetings pages', () => {
    const publicMeeting = proxy(tenantRequest('/meet/occurrence-public-id'));
    expect(publicMeeting.status).toBe(200);
    expect(publicMeeting.headers.get('x-middleware-next')).toBe('1');
    expect(publicMeeting.headers.get('location')).toBeNull();

    const meetingsWorkspace = proxy(tenantRequest('/meetings'));
    expect(meetingsWorkspace.status).toBe(307);
    expect(meetingsWorkspace.headers.get('location')).toBe(
      'http://acme.localhost:3000/login?callbackUrl=%2Fmeetings'
    );
  });
});

describe('actor-facing tenant URLs', () => {
  it('removes a forbidden cross-tenant organization id before rendering the dashboard', () => {
    const response = proxy(
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

  it('canonicalizes valid tenant navigation without exposing its internal id', () => {
    const response = proxy(
      authenticatedTenantRequest('/dashboard?organizationId=org_restaurant_a&view=operations')
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://acme.localhost:3000/dashboard?view=operations'
    );
  });

  it('keeps refresh canonical and cleans a raw-id history revisit again', () => {
    const canonical = proxy(authenticatedTenantRequest('/dashboard?view=operations'));
    expect(canonical.status).toBe(200);
    expect(canonical.headers.get('location')).toBeNull();

    const revisited = proxy(
      authenticatedTenantRequest('/dashboard?organizationId=org_restaurant_a&view=operations')
    );
    expect(revisited.headers.get('location')).toBe(
      'http://acme.localhost:3000/dashboard?view=operations'
    );
  });

  it('does not copy an internal organization id into an unauthenticated login URL', () => {
    const response = proxy(tenantRequest('/dashboard?organizationId=org_restaurant_a'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://acme.localhost:3000/dashboard');
    expect([...response.headers]).not.toContainEqual(
      expect.arrayContaining([expect.any(String), expect.stringContaining('org_restaurant_a')])
    );
  });
});
