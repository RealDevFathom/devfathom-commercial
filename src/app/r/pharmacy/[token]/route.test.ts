// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ cookies: vi.fn() }));
vi.mock('@/lib/pharmacy/whatsapp/hosted-receipt-store', () => ({
  authorizeHostedReceipt: vi.fn(),
}));
vi.mock('@/lib/rate-limit', () => ({ clientIp: () => '127.0.0.1', rateLimit: vi.fn() }));

import { cookies } from 'next/headers';
import { authorizeHostedReceipt } from '@/lib/pharmacy/whatsapp/hosted-receipt-store';
import {
  createReceiptOtpCode,
  issueHostedReceipt,
  readHostedReceipt,
} from '@/lib/pharmacy/whatsapp/hosted-receipt';
import { rateLimit } from '@/lib/rate-limit';
import { GET, POST } from './route';

const secret = 'test-hosted-receipt-secret-at-least-32-characters';
let proof: string | undefined;
let token: string;
const context = () => ({ params: Promise.resolve({ token }) });
const request = (body?: object) =>
  new Request(
    `https://pharmacy.example/r/pharmacy/${token}`,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : undefined
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('PHARMACY_HOSTED_RECEIPT_SECRET', secret);
  proof = undefined;
  const now = new Date();
  const issued = issueHostedReceipt(
    {
      organizationId: 'org-1',
      branchId: 'branch-1',
      saleId: 'sale-1',
      actorId: 'actor-1',
      consent: 'CUSTOMER_REQUEST',
      consentedAt: now.toISOString(),
      version: 1,
      branch: 'Gulberg',
      receiptNumber: '42',
      total: 'PKR 10.00',
      paymentMethod: 'CASH',
      rx: true,
      phone: '+923001234567',
      expiryDays: 30,
      now,
    },
    secret
  );
  token = issued.token;
  vi.mocked(authorizeHostedReceipt).mockResolvedValue(issued.receipt);
  vi.mocked(cookies).mockResolvedValue({
    get: () => (proof ? { value: proof } : undefined),
  } as never);
  vi.mocked(rateLimit).mockResolvedValue({ ok: true, retryAfter: 0, remaining: 4 });
});
afterEach(() => vi.unstubAllEnvs());

describe('hosted receipt customer access', () => {
  it('opens a customer page for browser navigation while preserving the JSON API', async () => {
    const response = await GET(
      new Request(request(), { headers: { Accept: 'text/html' } }),
      context()
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/r/pharmacy/${token}/view`);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('vary')).toBe('Accept');
  });

  it('withholds Rx details until POST verifies a code and installs a receipt-scoped cookie', async () => {
    const blocked = await GET(request(), context());
    expect(blocked.status).toBe(401);
    expect(await blocked.json()).toEqual({ otpRequired: true });

    const verified = await POST(request({ code: createReceiptOtpCode(token, secret) }), context());
    expect(verified.status).toBe(200);
    const cookie = verified.cookies.get('pharmacy_receipt_otp')!;
    expect(cookie).toMatchObject({
      httpOnly: true,
      sameSite: 'strict',
      path: `/r/pharmacy/${token}`,
    });
    proof = cookie.value;
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ receiptNumber: '42', total: 'PKR 10.00' });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('shows non-Rx receipts without OTP', async () => {
    vi.mocked(authorizeHostedReceipt).mockResolvedValue({
      ...readHostedReceipt(token, secret),
      rx: false,
    });
    expect((await GET(request(), context())).status).toBe(200);
  });

  it('rejects invalid codes and excessive verification attempts', async () => {
    expect((await POST(request({ code: '00000x' }), context())).status).toBe(400);
    vi.mocked(rateLimit).mockResolvedValue({ ok: false, retryAfter: 60, remaining: 0 });
    const response = await POST(request({ code: '123456' }), context());
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(response.cookies.get('pharmacy_receipt_otp')).toBeUndefined();
  });

  it.each(['Receipt link has expired.', 'Receipt link is unavailable.'])(
    'keeps revoked or expired receipts unavailable: %s',
    async (error) => {
      vi.mocked(authorizeHostedReceipt).mockRejectedValue(new Error(error));
      const response = await GET(request(), context());
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ error });
    }
  );
});
