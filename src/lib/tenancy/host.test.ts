import { afterEach, describe, expect, it } from 'vitest';

const ORIGINAL_BASE_DOMAIN = process.env.PLATFORM_BASE_DOMAIN;
const ORIGINAL_SHARED_HOSTS = process.env.SHARED_APP_HOSTS;

afterEach(() => {
  process.env.PLATFORM_BASE_DOMAIN = ORIGINAL_BASE_DOMAIN;
  if (ORIGINAL_SHARED_HOSTS === undefined) delete process.env.SHARED_APP_HOSTS;
  else process.env.SHARED_APP_HOSTS = ORIGINAL_SHARED_HOSTS;
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

describe('reserved infrastructure host labels', () => {
  it.each([
    'www',
    'admin',
    'app',
    'api',
    'staging',
    'meet',
    'meet-staging',
    'turn',
    'turn-staging',
    '  Meet-Staging  ',
  ])('reserves %j against organization slugs', async (label) => {
    const { isReservedHostLabel } = await import('./host-routing');

    expect(isReservedHostLabel(label)).toBe(true);
  });

  it('does not reserve an ordinary organization slug', async () => {
    const { isReservedHostLabel } = await import('./host-routing');

    expect(isReservedHostLabel('acme-group')).toBe(false);
  });
});

// D3 — the shared, slug-free application host. Before this, `www.devfathom.com`
// classified as `{ kind: 'tenant', slug: 'www' }`, and the default-host fallback
// then resolved it to DEFAULT_ORGANIZATION_ID: a silent misrouting, not an error.
describe('shared host classification', () => {
  it.each([
    ['www.devfathom.com'],
    ['app.devfathom.com'],
    ['api.devfathom.com'],
    ['staging.devfathom.com'],
    ['meet.devfathom.com'],
    ['meet-staging.devfathom.com'],
    ['turn.devfathom.com'],
    ['turn-staging.devfathom.com'],
  ])('classifies the reserved label host %s as shared', async (host) => {
    process.env.PLATFORM_BASE_DOMAIN = 'devfathom.com';
    const { classifyHost } = await import('./host-routing');

    expect(classifyHost(host)).toEqual({ kind: 'shared', host });
  });

  it('classifies the base-domain apex as shared', async () => {
    process.env.PLATFORM_BASE_DOMAIN = 'devfathom.com';
    const { classifyHost } = await import('./host-routing');

    expect(classifyHost('devfathom.com')).toEqual({ kind: 'shared', host: 'devfathom.com' });
  });

  // On staging the base domain IS the shared host, so the apex rule is what makes
  // staging.devfathom.com work while admin.staging.devfathom.com stays the
  // control plane.
  it('handles the staging deployment where the shared host is the base domain', async () => {
    process.env.PLATFORM_BASE_DOMAIN = 'staging.devfathom.com';
    const { classifyHost } = await import('./host-routing');

    expect(classifyHost('staging.devfathom.com').kind).toBe('shared');
    expect(classifyHost('admin.staging.devfathom.com').kind).toBe('platform');
    expect(classifyHost('acme.staging.devfathom.com')).toEqual({
      kind: 'tenant',
      host: 'acme.staging.devfathom.com',
      slug: 'acme',
    });
  });

  it('never classifies the control plane as shared', async () => {
    process.env.PLATFORM_BASE_DOMAIN = 'devfathom.com';
    const { classifyHost } = await import('./host-routing');

    expect(classifyHost('admin.devfathom.com').kind).toBe('platform');
  });

  // D2 — a bookmark to an existing per-tenant subdomain must keep working.
  it('leaves existing per-tenant subdomains resolving as tenants', async () => {
    process.env.PLATFORM_BASE_DOMAIN = 'devfathom.com';
    const { classifyHost } = await import('./host-routing');

    expect(classifyHost('acme.devfathom.com')).toEqual({
      kind: 'tenant',
      host: 'acme.devfathom.com',
      slug: 'acme',
    });
  });

  it('accepts an explicitly configured shared host that follows no label rule', async () => {
    process.env.PLATFORM_BASE_DOMAIN = 'devfathom.com';
    process.env.SHARED_APP_HOSTS = 'workspace.example.net, devfathom-stg.uaenorth.example.io';
    const { classifyHost } = await import('./host-routing');

    expect(classifyHost('workspace.example.net').kind).toBe('shared');
    expect(classifyHost('devfathom-stg.uaenorth.example.io').kind).toBe('shared');
  });

  it('offers shared local development hosts without disturbing localhost', async () => {
    process.env.PLATFORM_BASE_DOMAIN = 'localhost';
    const { classifyHost } = await import('./host-routing');

    expect(classifyHost('app.localhost:3000').kind).toBe('shared');
    expect(classifyHost('www.localhost:3000').kind).toBe('shared');
    // D4: the default-organization fallback for plain localhost stays intact.
    expect(classifyHost('localhost:3000')).toEqual({ kind: 'tenant', host: 'localhost' });
    expect(classifyHost('devfathom.localhost:3000')).toEqual({
      kind: 'tenant',
      host: 'devfathom.localhost',
      slug: 'devfathom',
    });
  });

  it('does not treat a deeper label as a reserved shared host', async () => {
    process.env.PLATFORM_BASE_DOMAIN = 'devfathom.com';
    const { classifyHost } = await import('./host-routing');

    // `evil.www.devfathom.com` is a customer-shaped host, not the shared app.
    expect(classifyHost('evil.www.devfathom.com')).toEqual({
      kind: 'tenant',
      host: 'evil.www.devfathom.com',
      slug: 'evil.www',
    });
  });
});

describe('unrecognised hosts', () => {
  it('returns unknown for an empty or missing host', async () => {
    const { classifyHost } = await import('./host-routing');

    expect(classifyHost(undefined)).toEqual({ kind: 'unknown', host: '' });
    expect(classifyHost(null)).toEqual({ kind: 'unknown', host: '' });
    expect(classifyHost('')).toEqual({ kind: 'unknown', host: '' });
    expect(classifyHost('   ')).toEqual({ kind: 'unknown', host: '' });
  });

  it('treats an unrelated public host as a tenant candidate with no slug', async () => {
    process.env.PLATFORM_BASE_DOMAIN = 'devfathom.com';
    const { classifyHost } = await import('./host-routing');

    // It carries no slug, so resolution falls through to verified custom domains
    // and ready deployments — and returns null when neither matches.
    expect(classifyHost('agency.example.org')).toEqual({
      kind: 'tenant',
      host: 'agency.example.org',
    });
  });

  it('classifies hosts even when no base domain is configured', async () => {
    delete process.env.PLATFORM_BASE_DOMAIN;
    const { classifyHost } = await import('./host-routing');

    expect(classifyHost('admin.localhost').kind).toBe('platform');
    expect(classifyHost('anything.example.com')).toEqual({
      kind: 'tenant',
      host: 'anything.example.com',
    });
  });
});

describe('reserved host labels', () => {
  it('reserves every label that would shadow a platform or shared host', async () => {
    const { RESERVED_HOST_LABELS } = await import('./host-routing');

    expect([...RESERVED_HOST_LABELS].sort()).toEqual([
      'admin',
      'api',
      'app',
      'meet',
      'meet-staging',
      'staging',
      'turn',
      'turn-staging',
      'www',
    ]);
  });
});
