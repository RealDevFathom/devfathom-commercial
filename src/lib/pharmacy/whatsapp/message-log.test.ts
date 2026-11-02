import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  update: vi.fn(),
  queryRaw: vi.fn(),
  customer: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: (_organizationId: string, fn: (db: unknown) => unknown) =>
    fn({
      pharmacyMessageLog: { createManyAndReturn: mocks.claim, update: mocks.update },
      pharmacyCustomer: { findFirst: mocks.customer },
      $queryRaw: mocks.queryRaw,
    }),
}));
import { sendAndLog } from './message-log';
import { WhatsAppProviderError } from './provider';

const entry = { organizationId: 'org-a', kind: 'ORDER_CONFIRMATION' as const, dedupeKey: 'one' };
const reminderEntry = { ...entry, kind: 'REFILL_REMINDER' as const, customerId: 'customer-a' };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.claim.mockResolvedValue([{ id: 'log-a' }]);
  mocks.update.mockResolvedValue({});
  mocks.queryRaw.mockResolvedValue([{ id: 'patient-a', patientId: 'patient-a' }]);
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
  it.each(['REFILL_REMINDER', 'KHATA_REMINDER', 'ORDER_CONFIRMATION'] as const)(
    're-checks opt-in after claiming and suppresses an opted-out %s',
    async (kind) => {
      mocks.customer
        .mockResolvedValueOnce({ patientId: 'patient-a' })
        .mockResolvedValueOnce({ active: true, whatsappOptIn: false });
      const send = vi.fn();

      await expect(sendAndLog({ ...reminderEntry, kind }, send)).resolves.toBe('PREPARED');

      const patientLock = mocks.queryRaw.mock.calls[0][0];
      const customerLock = mocks.queryRaw.mock.calls[1][0];
      expect(patientLock.sql).toContain('FROM pharmacy_patients');
      expect(patientLock.sql).toContain('FOR UPDATE');
      expect(patientLock.values).toEqual(['org-a', 'patient-a']);
      expect(customerLock.sql).toContain('FROM pharmacy_customers');
      expect(customerLock.sql).toContain('FOR UPDATE');
      expect(customerLock.values).toEqual(['org-a', 'customer-a']);
      expect(mocks.customer).toHaveBeenLastCalledWith({
        where: { organizationId: 'org-a', id: 'customer-a' },
        select: { active: true, whatsappOptIn: true },
      });
      expect(mocks.customer.mock.invocationCallOrder[1]).toBeGreaterThan(
        mocks.queryRaw.mock.invocationCallOrder[1]
      );
      expect(send).not.toHaveBeenCalled();
      expect(mocks.update).toHaveBeenCalledWith({
        where: { id: 'log-a' },
        data: { status: 'IGNORED', error: 'OPTED_OUT_BEFORE_SEND' },
      });
    }
  );
  it.each(['REFILL_REMINDER', 'KHATA_REMINDER', 'ORDER_CONFIRMATION'] as const)(
    'sends an eligible %s after locking its opted-in customer',
    async (kind) => {
      const send = vi.fn().mockResolvedValue({
        providerMessageId: 'reminder-1',
        acceptedByProvider: true,
      });

      await expect(sendAndLog({ ...reminderEntry, kind }, send)).resolves.toBe('SENT');

      expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
      expect(send.mock.invocationCallOrder[0]).toBeGreaterThan(
        mocks.customer.mock.invocationCallOrder[1]
      );
      expect(send).toHaveBeenCalledOnce();
      expect(mocks.update).toHaveBeenCalledWith({
        where: { id: 'log-a' },
        data: { status: 'SENT', providerMessageId: 'reminder-1' },
      });
    }
  );
  it.each([
    { active: false, whatsappOptIn: true },
    { active: true, whatsappOptIn: null },
  ])('suppresses a customer without current active opt-in: %j', async (customer) => {
    mocks.customer.mockResolvedValueOnce({ patientId: 'patient-a' }).mockResolvedValueOnce(customer);
    const send = vi.fn();

    await expect(sendAndLog({ ...entry, customerId: 'customer-a' }, send)).resolves.toBe('PREPARED');

    expect(send).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'log-a' },
      data: { status: 'IGNORED', error: 'OPTED_OUT_BEFORE_SEND' },
    });
  });
  it.each(['REFILL_REMINDER', 'KHATA_REMINDER'] as const)(
    'suppresses a %s that has no customer to prove explicit consent',
    async (kind) => {
      const send = vi.fn();

      await expect(sendAndLog({ ...entry, kind }, send)).resolves.toBe('PREPARED');

      expect(mocks.queryRaw).not.toHaveBeenCalled();
      expect(mocks.customer).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(mocks.update).toHaveBeenCalledWith({
        where: { id: 'log-a' },
        data: { status: 'IGNORED', error: 'OPTED_OUT_BEFORE_SEND' },
      });
    }
  );
  it.each(['patient', 'customer'] as const)(
    'waits for the %s consent lock and suppresses the send when STOP commits first',
    async (lock) => {
      let finishLock!: (rows: Array<{ id: string; patientId: string }>) => void;
      if (lock === 'customer') mocks.queryRaw.mockResolvedValueOnce([{ id: 'patient-a' }]);
      mocks.queryRaw.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishLock = resolve;
          })
      );
      const send = vi.fn();

      const outcome = sendAndLog(reminderEntry, send);
      await vi.waitFor(() =>
        expect(mocks.queryRaw).toHaveBeenCalledTimes(lock === 'patient' ? 1 : 2)
      );
      expect(mocks.customer).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();

      mocks.customer.mockResolvedValue({ active: true, whatsappOptIn: false });
      finishLock([{ id: 'patient-a', patientId: 'patient-a' }]);
      await expect(outcome).resolves.toBe('PREPARED');
      expect(send).not.toHaveBeenCalled();
    }
  );
  it('still sends STOP acknowledgements after the customer is opted out', async () => {
    mocks.customer.mockResolvedValue({ patientId: 'patient-a', active: true, whatsappOptIn: false });
    const send = vi.fn().mockResolvedValue({
      providerMessageId: 'ack-1',
      acceptedByProvider: true,
    });

    await expect(
      sendAndLog({ ...entry, kind: 'CONSENT_ACK', customerId: 'customer-a' }, send)
    ).resolves.toBe('SENT');

    expect(mocks.queryRaw).not.toHaveBeenCalled();
    expect(mocks.customer).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });
  it('treats an unclassified adapter response as unknown', async () => {
    expect(await sendAndLog(entry, async () => ({ providerMessageId: 'legacy' }))).toBe('UNKNOWN');
  });
});
