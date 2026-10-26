import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ claim: vi.fn(), update: vi.fn(), queryRaw: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: (_organizationId: string, fn: (db: unknown) => unknown) =>
    fn({
      pharmacyMessageLog: { createManyAndReturn: mocks.claim, update: mocks.update },
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
  mocks.queryRaw.mockResolvedValue([{ id: 'customer-a' }]);
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
  it.each(['REFILL_REMINDER', 'KHATA_REMINDER'] as const)(
    're-checks opt-in after claiming and suppresses an opted-out %s',
    async (kind) => {
      mocks.queryRaw.mockResolvedValue([]);
      const send = vi.fn();

      await expect(sendAndLog({ ...reminderEntry, kind }, send)).resolves.toBe('PREPARED');

      const query = mocks.queryRaw.mock.calls[0][0];
      expect(query.sql).toContain('"organizationId" = ?');
      expect(query.sql).toContain('id = ?');
      expect(query.sql).toContain('active = true');
      expect(query.sql).toContain('"whatsappOptIn" = true');
      expect(query.sql).toContain('FOR UPDATE');
      expect(query.values).toEqual(['org-a', 'customer-a']);
      expect(send).not.toHaveBeenCalled();
      expect(mocks.update).toHaveBeenCalledWith({
        where: { id: 'log-a' },
        data: { status: 'IGNORED', error: 'OPTED_OUT_BEFORE_SEND' },
      });
    }
  );
  it.each(['REFILL_REMINDER', 'KHATA_REMINDER'] as const)(
    'sends an eligible %s after locking its opted-in customer',
    async (kind) => {
      const send = vi.fn().mockResolvedValue({
        providerMessageId: 'reminder-1',
        acceptedByProvider: true,
      });

      await expect(sendAndLog({ ...reminderEntry, kind }, send)).resolves.toBe('SENT');

      expect(mocks.queryRaw).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledOnce();
      expect(mocks.update).toHaveBeenCalledWith({
        where: { id: 'log-a' },
        data: { status: 'SENT', providerMessageId: 'reminder-1' },
      });
    }
  );
  it('suppresses a reminder that has no customer to prove explicit consent', async () => {
    const send = vi.fn();

    await expect(
      sendAndLog({ ...entry, kind: 'REFILL_REMINDER' }, send)
    ).resolves.toBe('PREPARED');

    expect(mocks.queryRaw).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'log-a' },
      data: { status: 'IGNORED', error: 'OPTED_OUT_BEFORE_SEND' },
    });
  });
  it('waits for the consent row lock and suppresses the send when STOP commits first', async () => {
    let finishLock!: (rows: Array<{ id: string }>) => void;
    mocks.queryRaw.mockReturnValue(
      new Promise((resolve) => {
        finishLock = resolve;
      })
    );
    const send = vi.fn();

    const outcome = sendAndLog(reminderEntry, send);
    await vi.waitFor(() => expect(mocks.queryRaw).toHaveBeenCalledOnce());
    expect(send).not.toHaveBeenCalled();

    // An empty result after the lock wait models STOP updating and committing
    // while this sender waited for the same customer row.
    finishLock([]);
    await expect(outcome).resolves.toBe('PREPARED');
    expect(send).not.toHaveBeenCalled();
  });
  it('still sends STOP acknowledgements after the customer is opted out', async () => {
    const send = vi.fn().mockResolvedValue({
      providerMessageId: 'ack-1',
      acceptedByProvider: true,
    });

    await expect(
      sendAndLog({ ...entry, kind: 'CONSENT_ACK', customerId: 'customer-a' }, send)
    ).resolves.toBe('SENT');

    expect(mocks.queryRaw).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });
  it('treats an unclassified adapter response as unknown', async () => {
    expect(await sendAndLog(entry, async () => ({ providerMessageId: 'legacy' }))).toBe('UNKNOWN');
  });
});
