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

  it('marks the session cookie Secure after verification through the TLS proxy', async () => {
    const { verifyPortalSignIn } = await import('./customer-portal');
    vi.mocked(verifyPortalSignIn).mockResolvedValueOnce({
      ok: true,
      sessionToken: 'fixture-session',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const request = new Request('http://app:3000/api/pharmacy/portal/verify', {
      headers: {
        host: 'app:3000',
        'x-forwarded-host': 'tenant.example:8443',
        'x-forwarded-proto': 'https',
        origin: 'https://tenant.example:8443',
      },
    });
    const context = await portalContext(request);
    const response = await context!.handle('verify', {
      token: 'pcl_' + '3'.repeat(26),
      otp: '000001',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toMatch(/; Secure(?:;|$)/);
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

it('explains missing WhatsApp setup before looking up any customer link', async () => {
  resolveTenant.mockResolvedValue({ id: 'org', status: 'ACTIVE' });
  moduleEnabled.mockReturnValue(true);
  const context = await portalContext(new Request('http://pharmacy.localhost'));
  const response = await context!.handle('start', { token: 'pcl_' + '0'.repeat(26) });
  expect(await response.json()).toMatchObject({
    ok: false,
    message: 'The pharmacy has not finished setting up WhatsApp. Please ask the pharmacy for help.',
  });
});

describe('anonymous sign-in responses', () => {
  it('keeps the invalid link and rate-limit explanations actionable', async () => {
    const { portalResponse } = await import('./customer-portal-http');
    expect((await portalResponse.notFound().json()).message).toBe(
      'This link is no longer valid. Ask the pharmacy for a new one.'
    );
    const retry = portalResponse.limited(61);
    expect(retry.status).toBe(429);
    expect(retry.headers.get('Retry-After')).toBe('61');
    expect((await retry.json()).message).toBe('Too many tries. Please wait 2 minutes.');
  });

  it('accepts the request before checking the link or contacting the provider', async () => {
    const { after } = await import('next/server');
    const { startPortalSignIn, PharmacyPortalError } = await import('./customer-portal');
    const start = vi.mocked(startPortalSignIn);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = {
      PHARMACY_WHATSAPP_PROVIDER: 'meta',
      PHARMACY_WHATSAPP_ORGANIZATION_ID: 'org',
      PHARMACY_WHATSAPP_PHONE_NUMBER_ID: 'fixture',
      PHARMACY_WHATSAPP_ACCESS_TOKEN: 'fixture',
      PHARMACY_WHATSAPP_TEMPLATE_PORTAL_SIGN_IN_CODE: 'fixture',
      PHARMACY_WHATSAPP_LIVE_SEND: 'approved',
    };
    Object.entries(config).forEach(([key, value]) => vi.stubEnv(key, value));
    try {
      for (const failure of [null, 'LINK_INVALID', 'SEND_FAILED'] as const) {
        vi.clearAllMocks();
        if (failure) start.mockRejectedValueOnce(new PharmacyPortalError(failure));
        else start.mockResolvedValueOnce({ sentTo: 'private destination' });
        resolveTenant.mockResolvedValue({ id: 'org', status: 'ACTIVE' });
        moduleEnabled.mockReturnValue(true);
        const context = await portalContext(new Request('http://pharmacy.localhost'));
        const response = await context!.handle('start', { token: 'pcl_' + '1'.repeat(26) });
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ ok: true });
        expect(start).not.toHaveBeenCalled();
        const work = vi.mocked(after).mock.calls[0]![0];
        expect(typeof work).toBe('function');
        if (typeof work === 'function') await work();
        expect(start).toHaveBeenCalledTimes(1);
        if (failure === 'SEND_FAILED') {
          expect(log.mock.calls).toEqual([
            ['pharmacy.portal', { reason: 'SEND_FAILED', reference: expect.any(String) }],
          ]);
        }
      }
    } finally {
      vi.unstubAllEnvs();
      log.mockRestore();
    }
  });
});

vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: vi.fn(),
}));
vi.mock('./customer-portal', async (original) => ({
  ...(await original<typeof import('./customer-portal')>()),
  startPortalSignIn: vi.fn(),
  verifyPortalSignIn: vi.fn(),
}));

it('returns the support message and a redacted reference when verification is unavailable', async () => {
  const { verifyPortalSignIn } = await import('./customer-portal');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    vi.mocked(verifyPortalSignIn).mockRejectedValueOnce(new Error('private diagnostic'));
    resolveTenant.mockResolvedValue({ id: 'org', status: 'ACTIVE' });
    moduleEnabled.mockReturnValue(true);
    const context = await portalContext(new Request('http://pharmacy.localhost'));
    const response = await context!.handle('verify', {
      token: 'pcl_' + '2'.repeat(26),
      otp: '000001',
    });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      ok: false,
      message: 'Something went wrong on our side. Please try again.',
      reference: expect.any(String),
    });
    expect(log.mock.calls).toEqual([
      ['pharmacy.portal', { reason: 'UNEXPECTED', reference: body.reference }],
    ]);
  } finally {
    log.mockRestore();
  }
});
