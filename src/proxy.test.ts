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
});
