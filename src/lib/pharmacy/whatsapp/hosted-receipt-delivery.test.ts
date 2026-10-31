// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(), optedOut: vi.fn(), send: vi.fn(), db: {} as Record<string, unknown>,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: (_organizationId: string, run: (db: unknown) => unknown) => run(mocks.db),
}));
vi.mock('./hosted-receipt-store', () => ({
  authorizeHostedReceiptRecord: mocks.authorize,
  tenantHostedReceiptRecipientOptedOut: mocks.optedOut,
}));
vi.mock('./provider', async (original) => ({
  ...(await original<typeof import('./provider')>()),
  createWhatsAppProvider: () => ({ sendText: mocks.send }),
}));

import { createReceiptOtpCode, issueHostedReceipt } from './hosted-receipt';
import { deliverHostedReceipt, queueHostedReceiptDelivery } from './hosted-receipt-delivery';
import { WhatsAppProviderError } from './provider';

const secret = 'test-hosted-receipt-secret-at-least-32-characters';
let payload: Prisma.JsonValue;
let token: string;
let logRows: { id: string; dedupeKey: string; status: string; providerMessageId?: string; error?: string }[];
const updateReceipt = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-01T00:02:00.000Z'));
  vi.stubEnv('PHARMACY_HOSTED_RECEIPT_SECRET', secret);
  logRows = [];
  mocks.optedOut.mockResolvedValue(false);
  mocks.send.mockResolvedValue({ providerMessageId: 'real-1', acceptedByProvider: true });
  const now = new Date();
  const issued = issueHostedReceipt({
    organizationId: 'org-a', branchId: 'branch-a', saleId: 'sale-a', actorId: 'actor-a',
    consent: 'CUSTOMER_REQUEST', consentedAt: now.toISOString(), version: 1,
    branch: 'Gulberg', receiptNumber: '42', total: 'PKR 10.00', paymentMethod: 'CASH',
    rx: true, phone: '923001234567', expiryDays: 30,
  }, secret);
  token = issued.token;
  mocks.authorize.mockResolvedValue({ id: 'hosted-a', receipt: issued.receipt });
  mocks.db = {
    outboundEffect: { create: async (args: { data: { payload: Prisma.JsonValue } }) => { payload = args.data.payload; } },
    pharmacyHostedReceipt: { updateMany: updateReceipt },
    pharmacyMessageLog: {
      createManyAndReturn: async (args: { data: typeof logRows }) => {
        const entry = args.data[0];
        if (logRows.some((log) => log.dedupeKey === entry.dedupeKey)) return [];
        const row = { ...entry, id: `log-${logRows.length}` };
        logRows.push(row);
        return [{ id: row.id }];
      },
      update: async (args: { where: { id: string }; data: Partial<(typeof logRows)[number]> }) => {
        Object.assign(logRows.find((log) => log.id === args.where.id)!, args.data);
      },
      findFirst: async (args: { where: { dedupeKey: string } }) =>
        logRows.find((log) => log.dedupeKey === args.where.dedupeKey),
    },
  };
  await queueHostedReceiptDelivery(mocks.db as unknown as ScopedDb, {
    organizationId: 'org-a', recordId: 'hosted-a', token, phone: '923001234567',
    message: 'Receipt from Gulberg',
  }, secret);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('committed hosted receipt delivery', () => {
  it('encrypts the intent and sends each link and code once, even after a repeated drain', async () => {
    expect(JSON.stringify(payload)).not.toContain(token);
    expect(JSON.stringify(payload)).not.toContain('923001234567');
    expect(mocks.send).not.toHaveBeenCalled();
    await deliverHostedReceipt(payload, 'org-a');
    await deliverHostedReceipt(payload, 'org-a');
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(logRows).toHaveLength(2);
    expect(logRows.every((log) => log.status === 'SENT')).toBe(true);
    expect(mocks.send.mock.calls[1][0].body).toContain(createReceiptOtpCode(token, secret));
    expect(updateReceipt).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', id: 'hosted-a' },
      data: { providerMessageId: 'real-1', deliveredAt: expect.any(Date) },
    });
  });

  it.each(['org-b', 'tampered'])(
    'rejects a delivery copied to %s before any provider or receipt access', async (target) => {
      const tampered = { ciphertext: `${(payload as { ciphertext: string }).ciphertext}bad` };
      await expect(deliverHostedReceipt(target === 'tampered' ? tampered : payload,
        target === 'tampered' ? 'org-a' : target)).rejects.toThrow();
      expect(mocks.authorize).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
    }
  );

  it('rechecks revocation and opt-out before a queued delivery', async () => {
    mocks.authorize.mockRejectedValueOnce(new Error('Receipt link is unavailable.'));
    await expect(deliverHostedReceipt(payload, 'org-a')).rejects.toThrow('unavailable');
    expect(mocks.send).not.toHaveBeenCalled();
    mocks.optedOut.mockResolvedValueOnce(true);
    await deliverHostedReceipt(payload, 'org-a');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('keeps a definitive failure logged and does not automatically resend it', async () => {
    mocks.send.mockRejectedValueOnce(new WhatsAppProviderError('NOT_CONFIGURED'));
    await deliverHostedReceipt(payload, 'org-a');
    await deliverHostedReceipt(payload, 'org-a');
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(logRows).toEqual([expect.objectContaining({ status: 'FAILED', error: 'NOT_CONFIGURED' })]);
    expect(updateReceipt).not.toHaveBeenCalled();
  });

  it('does not mark mock preparation as delivered', async () => {
    mocks.send.mockResolvedValue({ providerMessageId: 'mock-1', acceptedByProvider: false });
    await deliverHostedReceipt(payload, 'org-a');
    expect(updateReceipt).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', id: 'hosted-a' },
      data: { providerMessageId: 'mock-1' },
    });
    expect(logRows.every((log) => log.status === 'IGNORED')).toBe(true);
  });

  it('keeps link acceptance separate from a failed OTP delivery', async () => {
    mocks.send.mockResolvedValueOnce({ providerMessageId: 'real-1', acceptedByProvider: true });
    mocks.send.mockRejectedValueOnce(new WhatsAppProviderError('NOT_CONFIGURED'));
    await deliverHostedReceipt(payload, 'org-a');
    expect(logRows.map((log) => log.status)).toEqual(['SENT', 'FAILED']);
    expect(updateReceipt).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', id: 'hosted-a' },
      data: { providerMessageId: 'real-1', deliveredAt: expect.any(Date) },
    });
  });

  it('repairs receipt acknowledgement metadata on retry without resending the link', async () => {
    updateReceipt.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(deliverHostedReceipt(payload, 'org-a')).rejects.toThrow('database unavailable');
    expect(mocks.send).toHaveBeenCalledTimes(1);
    await deliverHostedReceipt(payload, 'org-a');
    expect(mocks.send).toHaveBeenCalledTimes(2); // link once, OTP once
    expect(logRows[0].status).toBe('SENT');
  });
});
