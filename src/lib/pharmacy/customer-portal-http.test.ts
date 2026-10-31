import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  customerPortalGET,
  customerPortalPOST,
  portalBody,
  portalCookie,
} from './customer-portal-http';
import { resolveExplicitOrganizationByHost } from '@/lib/tenancy/host';
import { rateLimit } from '@/lib/rate-limit';
import {
  CustomerPortalError,
  consumePortalOtp,
  customerPortalScope,
  customerPortalSummary,
  issuePortalOtp,
} from './customer-portal';
import { sendCustomerSms } from './customer-otp-delivery';

const mockDb = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn().mockResolvedValue([{ id: 'branch-a', name: 'Branch A' }]),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: (_org: string, fn: (db: unknown) => unknown) => fn(mockDb),
}));
vi.mock('@/lib/tenancy/host', () => ({
  requestHost: () => 'acme.localhost',
  resolveExplicitOrganizationByHost: vi.fn(),
  isTenantLifecycleAccessible: (s: string) => s === 'ACTIVE',
}));
vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: vi.fn(),
  hasModule: () => true,
}));
vi.mock('@/lib/rate-limit', () => ({ clientIp: () => '127.0.0.1', rateLimit: vi.fn() }));
vi.mock('./customer-otp-delivery', () => ({
  customerSmsConfigured: () => true,
  sendCustomerSms: vi.fn(),
}));
vi.mock('./customer-portal', async (original) => {
  const { CustomerPortalError, portalHash } = await original<typeof import('./customer-portal')>();
  return {
    CustomerPortalError,
    portalHash,
    consumePortalOtp: vi.fn(),
    customerPortalScope: vi.fn(),
    customerPortalSummary: vi.fn(),
    issuePortalOtp: vi.fn(),
    createPortalRequest: vi.fn(),
    portalReceipt: vi.fn(),
    portalEvent: vi.fn(),
  };
});
vi.mock('./counter', () => ({ readCounterReceipt: vi.fn() }));
vi.mock('./family-khata', () => ({ readKhataBalance: vi.fn() }));
vi.mock('./prescription-files', () => ({ persistPrescriptionFile: vi.fn() }));

const command = (body: unknown, origin = 'http://acme.localhost:3000', cookie?: string) =>
  new Request('http://acme.localhost:3000/api/pharmacy/customer', {
    method: 'POST',
    headers: {
      host: 'acme.localhost:3000',
      origin,
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rateLimit).mockResolvedValue({ ok: true, remaining: 10, retryAfter: 0 });
  vi.mocked(resolveExplicitOrganizationByHost).mockResolvedValue({
    id: 'org-a',
    displayName: 'Pharmacy',
    currency: 'PKR',
    status: 'ACTIVE',
  } as NonNullable<Awaited<ReturnType<typeof resolveExplicitOrganizationByHost>>>);
});

describe('public customer transport', () => {
  it('clears an expired customer cookie so the public sign-in can be retried', async () => {
    vi.mocked(customerPortalScope).mockRejectedValueOnce(
      new CustomerPortalError(401, 'Your session has expired.')
    );
    const response = await customerPortalGET(
      new Request('http://acme.localhost/api/pharmacy/customer', {
        headers: { cookie: 'df_customer=expired' },
      })
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
  it('serves sign-in to anonymous visitors and ignores staff sessions', async () => {
    const response = await customerPortalGET(
      new Request('http://acme.localhost:3000/api/pharmacy/customer', {
        headers: { cookie: 'authjs.session-token=staff' },
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      signedIn: false,
      branches: [{ id: 'branch-a' }],
    });
    expect(customerPortalScope).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it('rejects shared/unbound hosts without trusting a tenant id in the body', async () => {
    vi.mocked(resolveExplicitOrganizationByHost).mockResolvedValue(null);
    expect(
      (
        await customerPortalPOST(
          command({ action: 'start', branchId: 'branch-a', phone: '03001234567' })
        )
      ).status
    ).toBe(404);
    expect(issuePortalOtp).not.toHaveBeenCalled();
  });
  it('rejects cross-origin and missing-origin mutations before DB or SMS work', async () => {
    expect(
      (await customerPortalPOST(command({ action: 'logout' }, 'https://other.example'))).status
    ).toBe(403);
    const missing = command({ action: 'logout' });
    missing.headers.delete('origin');
    expect((await customerPortalPOST(missing)).status).toBe(403);
    expect(resolveExplicitOrganizationByHost).not.toHaveBeenCalled();
    expect(sendCustomerSms).not.toHaveBeenCalled();
  });
  it('returns identical accepted shapes for registered and unknown phone numbers', async () => {
    const input = { action: 'start', branchId: 'branch-a', phone: '03001234567' };
    vi.mocked(issuePortalOtp).mockResolvedValue(null);
    const unknown = await customerPortalPOST(command(input));
    vi.mocked(issuePortalOtp).mockResolvedValue({ phone: '923001234567', code: '123456' });
    const known = await customerPortalPOST(command(input));
    expect([unknown.status, known.status]).toEqual([202, 202]);
    const unknownBody = await unknown.json();
    const knownBody = await known.json();
    expect(knownBody).toEqual({ ...unknownBody, challengeId: expect.any(String) });
    expect(knownBody).not.toHaveProperty('code');
    expect(sendCustomerSms).toHaveBeenCalledWith('org-a', '923001234567', '123456');
  });
  it('sets an HttpOnly, narrow-path customer cookie only after a successful OTP', async () => {
    const input = {
      action: 'verify',
      challengeId: 'cc56d757-2cd8-4bbf-b077-18def61fa649',
      code: '123456',
    };
    vi.mocked(consumePortalOtp).mockResolvedValue(null);
    const denied = await customerPortalPOST(command(input));
    expect(denied.status).toBe(400);
    expect(denied.headers.get('set-cookie')).toBeNull();
    vi.mocked(consumePortalOtp).mockResolvedValue({ token: 'opaque', maxAge: 3600 });
    const response = await customerPortalPOST(command(input));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBe(portalCookie('opaque', 3600));
    expect(response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
  });
  it('uses only the resolved customer identity for private reads', async () => {
    const scope = {
      organizationId: 'org-a',
      branchId: 'branch-a',
      customerId: 'customer-a',
      patientId: 'patient-a',
    };
    vi.mocked(customerPortalScope).mockResolvedValue(scope);
    vi.mocked(customerPortalSummary).mockResolvedValue({ customerName: 'A' } as Awaited<
      ReturnType<typeof customerPortalSummary>
    >);
    const response = await customerPortalGET(
      new Request('http://acme.localhost/api/pharmacy/customer?customerId=customer-b', {
        headers: { cookie: 'df_customer=opaque' },
      })
    );
    expect(response.status).toBe(200);
    expect(customerPortalSummary).toHaveBeenCalledWith(mockDb, scope, 'PKR');
  });
  it('rate limits anonymous traffic before any tenant lookup or delivery', async () => {
    vi.mocked(rateLimit).mockResolvedValue({ ok: false, remaining: 0, retryAfter: 60 });
    expect(
      (
        await customerPortalPOST(
          command({ action: 'start', branchId: 'branch-a', phone: '03001234567' })
        )
      ).status
    ).toBe(429);
    expect(resolveExplicitOrganizationByHost).not.toHaveBeenCalled();
  });
  it('bounds body reads even without a Content-Length header', async () => {
    await expect(portalBody(command({ data: 'a'.repeat(1024) }), 100)).rejects.toMatchObject({
      status: 413,
    });
  });
});
