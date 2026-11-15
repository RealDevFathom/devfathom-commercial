import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  verify: vi.fn(),
  rateLimit: vi.fn(),
  organization: vi.fn(),
}));

vi.mock('@/lib/pharmacy/hosted-receipt-service', () => ({
  sendHostedReceiptOtp: mocks.send,
  verifyHostedReceiptOtp: mocks.verify,
}));
vi.mock('@/lib/rate-limit', () => ({
  clientIp: () => '203.0.113.9',
  rateLimit: mocks.rateLimit,
}));
vi.mock('@/lib/tenancy/host', () => ({
  requestHost: (request: Request) => request.headers.get('host') ?? '',
  resolveOrganizationForRequest: mocks.organization,
  isTenantLifecycleAccessible: (status: string) => status === 'ACTIVE',
}));

const { POST } = await import('./route');

const token = '0123456789abcdefghjkmnpqrstvwxyz';

function request(body: unknown, origin = 'https://acme.devfathom.app') {
  return new Request('https://acme.devfathom.app/api/pharmacy/hosted-receipt/otp', {
    method: 'POST',
    headers: { host: 'acme.devfathom.app', origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockResolvedValue({ ok: true, retryAfter: 0 });
  mocks.organization.mockResolvedValue({ id: 'org-1', vertical: 'PHARMACY', status: 'ACTIVE' });
});

describe('DEV-16 hosted receipt one-time code route', () => {
  it('sends a code for the host tenant and is never indexed or cached', async () => {
    mocks.send.mockResolvedValue('SENT');
    const response = await POST(request({ action: 'send', token }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(mocks.send).toHaveBeenCalledWith({ organizationId: 'org-1', token });
  });

  it('reveals the receipt only for a verified code', async () => {
    mocks.verify.mockResolvedValueOnce({ receiptNumber: 1042 });
    const ok = await POST(request({ action: 'verify', token, otp: '123456' }));
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toMatchObject({ ok: true, receipt: { receiptNumber: 1042 } });

    mocks.verify.mockResolvedValueOnce(null);
    const refused = await POST(request({ action: 'verify', token, otp: '654321' }));
    expect(refused.status).toBe(400);
    expect(await refused.json()).not.toHaveProperty('receipt');
  });

  it('refuses cross-origin calls, malformed input and non-pharmacy or closed tenants', async () => {
    expect((await POST(request({ action: 'send', token }, 'https://evil.example'))).status).toBe(
      403
    );
    expect((await POST(request({ action: 'send', token: 'short' }))).status).toBe(400);
    expect((await POST(request({ action: 'verify', token, otp: '12ab56' }))).status).toBe(400);
    mocks.organization.mockResolvedValueOnce({
      id: 'org-2',
      vertical: 'HOSPITALITY',
      status: 'ACTIVE',
    });
    expect((await POST(request({ action: 'send', token }))).status).toBe(400);
    mocks.organization.mockResolvedValueOnce({
      id: 'org-1',
      vertical: 'PHARMACY',
      status: 'SUSPENDED',
    });
    expect((await POST(request({ action: 'send', token }))).status).toBe(400);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it('rate-limits by client and by link', async () => {
    mocks.rateLimit.mockResolvedValueOnce({ ok: true, retryAfter: 0 });
    mocks.rateLimit.mockResolvedValueOnce({ ok: false, retryAfter: 120 });
    const response = await POST(request({ action: 'verify', token, otp: '123456' }));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('120');
    expect(mocks.verify).not.toHaveBeenCalled();
  });
});
