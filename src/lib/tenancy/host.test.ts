import { afterEach, describe, expect, it } from 'vitest';

const ORIGINAL_BASE_DOMAIN = process.env.PLATFORM_BASE_DOMAIN;

afterEach(() => {
  process.env.PLATFORM_BASE_DOMAIN = ORIGINAL_BASE_DOMAIN;
});

describe('tenant host classification', () => {
  it('normalizes ports, forwarding lists, case, and trailing dots', async () => {
    const { normalizeHost } = await import('./host-routing');

    expect(normalizeHost('Agency.Example.com.:443, proxy.internal')).toBe('agency.example.com');
    expect(normalizeHost('[::1]:3000')).toBe('::1');
  });

  it('separates the platform host from organization subdomains', async () => {
    process.env.PLATFORM_BASE_DOMAIN = 'hub.example.com';
    const { classifyHost } = await import('./host-routing');

    expect(classifyHost('admin.hub.example.com')).toEqual({
      kind: 'platform',
      host: 'admin.hub.example.com',
    });
    expect(classifyHost('northwind.hub.example.com')).toEqual({
      kind: 'tenant',
      host: 'northwind.hub.example.com',
      slug: 'northwind',
    });
  });

  it('supports local tenant and platform development hosts', async () => {
    const { classifyHost } = await import('./host-routing');

    expect(classifyHost('admin.localhost:3000').kind).toBe('platform');
    expect(classifyHost('agency.localhost:3000')).toEqual({
      kind: 'tenant',
      host: 'agency.localhost',
      slug: 'agency',
    });
  });
});
