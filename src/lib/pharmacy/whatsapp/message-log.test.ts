import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  update: vi.fn(),
  execute: vi.fn(),
  /** Which tenant transaction each log update / capture update ran in. */
  trail: [] as Array<[string, number]>,
  transactions: 0,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: (_organizationId: string, fn: (db: unknown) => unknown) => {
    const transaction = ++mocks.transactions;
    return fn({
      pharmacyMessageLog: {
        createManyAndReturn: mocks.claim,
        update: (args: unknown) => {
          mocks.trail.push(['log', transaction]);
          return mocks.update(args);
        },
      },
      $executeRaw: (query: unknown) => {
        mocks.trail.push(['capture', transaction]);
        return mocks.execute(query);
      },
    });
  },
}));
import { sendAndLog } from './message-log';
import { WhatsAppProviderError } from './provider';

const entry = { organizationId: 'org-a', kind: 'REFILL_REMINDER' as const, dedupeKey: 'one' };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.trail = [];
  mocks.transactions = 0;
  mocks.claim.mockResolvedValue([{ id: 'log-a' }]);
  mocks.update.mockResolvedValue({});
  mocks.execute.mockResolvedValue(1);
});

const refillEntry = {
  ...entry,
  dedupeKey: 'refill-capture:capture-a',
  branchId: 'branch-a',
  refillCaptureId: 'capture-a',
};

describe('refill reminder acceptance', () => {
  it('marks the capture sent in the same transaction as the accepted log', async () => {
    expect(
      await sendAndLog(refillEntry, async () => ({
        providerMessageId: 'real-1',
        acceptedByProvider: true,
      }))
    ).toBe('SENT');
    // Transaction 1 is the claim; acceptance and capture share transaction 2.
    expect(mocks.trail).toEqual([
      ['log', 2],
      ['capture', 2],
    ]);
    const capture = mocks.execute.mock.calls[0]![0] as { values: unknown[] };
    expect(capture.values).toEqual(
      expect.arrayContaining(['org-a', 'branch-a', 'capture-a', 'log-a', 'real-1'])
    );
  });

  it.each([false, undefined])(
    'never marks the capture sent without provider acceptance (accepted: %s)',
    async (acceptedByProvider) => {
      await sendAndLog(refillEntry, async () => ({ providerMessageId: 'p-1', acceptedByProvider }));
      expect(mocks.execute).not.toHaveBeenCalled();
    }
  );

  it('fails the acceptance transaction itself when the capture transition fails', async () => {
    mocks.execute.mockRejectedValue(new Error('capture guard'));
    await expect(
      sendAndLog(refillEntry, async () => ({
        providerMessageId: 'real-1',
        acceptedByProvider: true,
      }))
    ).rejects.toThrow('capture guard');
    expect(mocks.trail).toEqual([
      ['log', 2],
      ['capture', 2],
    ]);
  });
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
  it('treats an unclassified adapter response as unknown', async () => {
    expect(await sendAndLog(entry, async () => ({ providerMessageId: 'legacy' }))).toBe('UNKNOWN');
  });
});
