import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveTenant, moduleEnabled } = vi.hoisted(() => ({
  resolveTenant: vi.fn(),
  moduleEnabled: vi.fn(),
}));
vi.mock('@/lib/tenancy/host', async (original) => ({
  ...(await original<typeof import('@/lib/tenancy/host')>()),
  resolveOrganizationForRequest: resolveTenant,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: async (_id: string, run: (db: object) => unknown) => run({}),
}));
vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: vi.fn(),
  hasModule: moduleEnabled,
}));

import { portalContext } from './customer-portal-http';

describe('customer portal tenant and browser origin', () => {
  const authority = 'pharmacy.localhost:3111';
  const url = 'http://' + authority;
  beforeEach(() => {
    vi.clearAllMocks();
    resolveTenant.mockResolvedValue({ id: 'org', status: 'ACTIVE' });
    moduleEnabled.mockReturnValue(true);
  });

  it('accepts a browser on the tenant host and port', async () => {
    expect(
      await portalContext(new Request(url, { headers: { host: authority, origin: url } }))
    ).toBeTruthy();
  });

  it.each(['http://pharmacy.localhost:3112', 'http://elsewhere.localhost:3111', 'null'])(
    'refuses a different origin before tenant lookup (%s)',
    async (origin) => {
      expect(
        await portalContext(new Request(url, { headers: { host: authority, origin } }))
      ).toBeNull();
      expect(resolveTenant).not.toHaveBeenCalled();
    }
  );

  it('preserves tenant and license checks for requests without Origin', async () => {
    const request = new Request(url, { headers: { host: authority } });
    expect(await portalContext(request)).toBeTruthy();
    moduleEnabled.mockReturnValue(false);
    expect(await portalContext(request)).toBeNull();
  });

  it('accepts the public HTTPS authority supplied by the internal reverse proxy', async () => {
    const headers = {
      host: 'app:3000',
      'x-forwarded-host': 'tenant.example:8443',
      'x-forwarded-proto': 'https',
      origin: 'https://tenant.example:8443',
    };
    expect(await portalContext(new Request('http://app:3000', { headers }))).toBeTruthy();
  });

  it('refuses an unrelated forwarded authority on a direct public request', async () => {
    const headers = {
      host: 'tenant.example',
      'x-forwarded-host': 'other.example',
      origin: 'https://other.example',
    };
    expect(await portalContext(new Request('https://tenant.example', { headers }))).toBeNull();
  });
});
