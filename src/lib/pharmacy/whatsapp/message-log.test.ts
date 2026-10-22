import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ claim: vi.fn(), update: vi.fn(), customer: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: (_organizationId: string, fn: (db: unknown) => unknown) =>
    fn({
      $queryRaw: vi.fn().mockResolvedValue([{ patientId: 'patient-a' }]),
      pharmacyCustomer: { findFirst: mocks.customer },
      pharmacyMessageLog: { createManyAndReturn: mocks.claim, update: mocks.update },
    }),
}));
import { sendAndLog } from './message-log';
import { WhatsAppProviderError } from './provider';

const entry = { organizationId: 'org-a', kind: 'REFILL_REMINDER' as const, dedupeKey: 'one' };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.claim.mockResolvedValue([{ id: 'log-a' }]);
  mocks.update.mockResolvedValue({});
  mocks.customer.mockResolvedValue({ patientId: 'patient-a', active: true, whatsappOptIn: true });
});

describe('outbound evidence and safe replay', () => {
  it('records a mock as preparation, never SENT', async () => {
    expect(
      await sendAndLog(entry, async () => ({
        providerMessageId: 'mock-1',
        acceptedByProvider: false,
      }))
    ).toBe('PREPARED');
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'log-a' },
      data: {
        status: 'IGNORED',
        providerMessageId: 'mock-1',
        error: 'MOCK_PREPARED',
      },
    });
  });
  it('records only explicit provider acceptance as SENT, not delivered', async () => {
    expect(
      await sendAndLog(entry, async () => ({
        providerMessageId: 'real-1',
        acceptedByProvider: true,
      }))
    ).toBe('SENT');
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'log-a' },
      data: {
        status: 'SENT',
        providerMessageId: 'real-1',
      },
    });
  });
  it('keeps transport uncertainty pending and redacts arbitrary error details', async () => {
    expect(
      await sendAndLog(entry, async () => {
        throw new Error('private recipient and message');
      })
    ).toBe('UNKNOWN');
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'log-a' },
      data: {
        status: 'PENDING',
        error: 'UNKNOWN_PROVIDER_OUTCOME',
      },
    });
  });
  it('fails only on definitive pre-send or provider rejection evidence', async () => {
    expect(
      await sendAndLog(entry, async () => {
        throw new WhatsAppProviderError('NOT_CONFIGURED');
      })
    ).toBe('FAILED');
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'log-a' },
      data: {
        status: 'FAILED',
        error: 'NOT_CONFIGURED',
      },
    });
  });
  it('does not overwrite acceptance as FAILED when persistence fails', async () => {
    mocks.update.mockRejectedValue(new Error('database unavailable'));
    await expect(
      sendAndLog(entry, async () => ({ providerMessageId: 'real-1', acceptedByProvider: true }))
    ).rejects.toThrow('database unavailable');
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0][0].data.status).toBe('SENT');
  });
  it('never retries an already claimed message, including UNKNOWN', async () => {
    mocks.claim.mockResolvedValue([]);
    const send = vi.fn();
    expect(await sendAndLog(entry, send)).toBe('DUPLICATE');
    expect(send).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('cancels a claimed message when the customer opts out before send', async () => {
    mocks.customer.mockResolvedValueOnce({ patientId: 'patient-a' }).mockResolvedValueOnce({
      active: true,
      whatsappOptIn: false,
    });
    const send = vi.fn();
    expect(await sendAndLog({ ...entry, customerId: 'customer-a' }, send)).toBe('CANCELLED');
    expect(send).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'log-a' },
      data: { status: 'IGNORED', error: 'OPTED_OUT' },
    });
  });
  it('treats an unclassified adapter response as unknown', async () => {
    expect(await sendAndLog(entry, async () => ({ providerMessageId: 'legacy' }))).toBe('UNKNOWN');
  });
});
