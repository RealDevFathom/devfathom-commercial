// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/pharmacy/whatsapp/hosted-receipt-store', () => ({
  authorizeHostedReceiptRecord: vi.fn(),
  tenantHostedReceiptRecipientOptedOut: vi.fn(async () => false),
}));
vi.mock('@/lib/pharmacy/whatsapp/message-log', () => ({
  sendAndLog: vi.fn(async (_entry: unknown, send: () => Promise<unknown>) => {
    await send();
    return 'SENT';
  }),
}));
vi.mock('@/lib/pharmacy/whatsapp/provider', () => ({ createWhatsAppProvider: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ clientIp: () => '127.0.0.1', rateLimit: vi.fn() }));

import {
  authorizeHostedReceiptRecord,
  tenantHostedReceiptRecipientOptedOut,
} from '@/lib/pharmacy/whatsapp/hosted-receipt-store';
import {
  issueHostedReceipt,
  verifyReceiptOtpCode,
  type HostedReceipt,
} from '@/lib/pharmacy/whatsapp/hosted-receipt';
import { sendAndLog } from '@/lib/pharmacy/whatsapp/message-log';
import { createWhatsAppProvider } from '@/lib/pharmacy/whatsapp/provider';
import { rateLimit } from '@/lib/rate-limit';
import { POST } from './route';

const secret = 'test-hosted-receipt-secret-at-least-32-characters';
const sendText = vi.fn(async (_input: { to: string; body: string }) => ({
  providerMessageId: 'wamid-1',
  acceptedByProvider: true,
}));
let token: string;
let receipt: HostedReceipt;
const context = () => ({ params: Promise.resolve({ token }) });
const request = (body: unknown) =>
  new Request(`https://pharmacy.example/r/pharmacy/${token}/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('PHARMACY_HOSTED_RECEIPT_SECRET', secret);
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
      phone: '923001234567',
      expiryDays: 30,
      now,
    },
    secret
  );
  token = issued.token;
  receipt = issued.receipt;
  vi.mocked(authorizeHostedReceiptRecord).mockResolvedValue({ id: 'hosted-1', receipt });
  vi.mocked(createWhatsAppProvider).mockReturnValue({ sendText } as never);
  vi.mocked(rateLimit).mockResolvedValue({ ok: true, retryAfter: 0, remaining: 2 });
});

afterEach(() => vi.unstubAllEnvs());

describe('hosted Rx receipt code resend', () => {
  it('sends a fresh, verifiable code only to the bound number, days after issue', async () => {
    const response = await POST(request({ phone: '0300 1234567' }), context());
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toMatch(/\d{6}/);
    expect(sendText).toHaveBeenCalledTimes(1);
    const sent = sendText.mock.calls[0][0];
    expect(sent.to).toBe('923001234567');
    const code = sent.body.match(/\b(\d{6})\b/)?.[1] ?? '';
    expect(verifyReceiptOtpCode(token, code, secret)).toBe(true);
    expect(vi.mocked(sendAndLog).mock.calls[0][0]).toMatchObject({
      organizationId: 'org-1',
      branchId: 'branch-1',
      kind: 'HOSTED_RECEIPT',
      dedupeKey: expect.stringMatching(/^hosted-receipt-code:hosted-1:\d+$/),
      phoneLast4: '4567',
    });
  });

  it('answers identically for a different number but sends nothing', async () => {
    const response = await POST(request({ phone: '+92 311 0000000' }), context());
    expect(response.status).toBe(202);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('never messages a number that opted out', async () => {
    vi.mocked(tenantHostedReceiptRecipientOptedOut).mockResolvedValueOnce(true);
    expect((await POST(request({ phone: '03001234567' }), context())).status).toBe(202);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('rate-limits code requests', async () => {
    vi.mocked(rateLimit).mockResolvedValue({ ok: false, retryAfter: 120, remaining: 0 });
    const response = await POST(request({ phone: '03001234567' }), context());
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('120');
    expect(sendText).not.toHaveBeenCalled();
  });

  it('refuses revoked links, non-Rx receipts and malformed numbers without detail', async () => {
    expect((await POST(request({ phone: 'abc' }), context())).status).toBe(400);
    vi.mocked(authorizeHostedReceiptRecord).mockResolvedValueOnce({
      id: 'hosted-1',
      receipt: { ...receipt, rx: false },
    });
    expect((await POST(request({ phone: '03001234567' }), context())).status).toBe(400);
    vi.mocked(authorizeHostedReceiptRecord).mockRejectedValueOnce(new Error('db exploded'));
    const gone = await POST(request({ phone: '03001234567' }), context());
    expect(gone.status).toBe(410);
    expect(await gone.json()).toEqual({ error: 'Receipt link is unavailable.' });
    expect(sendText).not.toHaveBeenCalled();
  });
});
