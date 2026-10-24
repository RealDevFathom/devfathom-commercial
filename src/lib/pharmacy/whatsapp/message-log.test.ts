import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applySendAuthorityUpdate,
  deferred,
  rendezvous,
} from '../../../../tests/support/whatsapp-message-log-store';

type Row = Record<string, unknown> & { id: string };
const mocks = vi.hoisted(() => ({
  rows: [] as Row[],
  claim: vi.fn(),
  authority: vi.fn(),
  update: vi.fn(),
  beforeAuthority: undefined as undefined | (() => Promise<void>),
  failAuthorityCommit: false,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: async (_organizationId: string, fn: (db: unknown) => unknown) => {
    const result = await fn({
      pharmacyMessageLog: {
        createManyAndReturn: mocks.claim,
        updateMany: mocks.authority,
        update: mocks.update,
      },
    });
    if (mocks.failAuthorityCommit && result && typeof result === 'object' && 'count' in result) {
      throw new Error('authority commit uncertain');
    }
    return result;
  },
}));
import { claimMessageLog, sendAndLog, sendClaimedMessage } from './message-log';
import { WhatsAppProviderError } from './provider';

const entry = {
  organizationId: 'org-a',
  kind: 'ORDER_CONFIRMATION' as const,
  dedupeKey: 'out:one',
};
const accepted = { providerMessageId: 'real-1', acceptedByProvider: true };
function existing(status: string, error: string | null = null, extra: object = {}) {
  const row = { ...entry, id: 'log-1', direction: 'OUTBOUND', status, error, ...extra };
  mocks.rows.push(row);
  return row;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.rows = [];
  mocks.beforeAuthority = undefined;
  mocks.failAuthorityCommit = false;
  mocks.claim.mockImplementation(async ({ data }: { data: Row[] }) => {
    const entry = data[0]!;
    if (
      mocks.rows.some(
        (row) => row.organizationId === entry.organizationId && row.dedupeKey === entry.dedupeKey
      )
    )
      return [];
    const row = { ...entry, id: 'log-' + (mocks.rows.length + 1) };
    mocks.rows.push(row);
    return [{ id: row.id }];
  });
  mocks.authority.mockImplementation(async (args) => {
    await mocks.beforeAuthority?.();
    return applySendAuthorityUpdate(mocks.rows, args);
  });
  mocks.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: object }) =>
      Object.assign(
        mocks.rows.find((row) => row.id === where.id)!,
        data
      )
  );
});

describe('outbound evidence and safe replay', () => {
  it('marks only outbound reservations as unattempted, leaving inbound claims unchanged', async () => {
    await claimMessageLog({ ...entry, direction: 'OUTBOUND', status: 'PENDING' });
    expect(mocks.rows[0]).toMatchObject({ status: 'PENDING', error: 'SEND_RESERVED' });
    const inbound = {
      ...entry,
      dedupeKey: 'in:one',
      direction: 'INBOUND' as const,
      status: 'RECEIVED' as const,
    };
    await claimMessageLog(inbound);
    expect(mocks.claim).toHaveBeenLastCalledWith({
      data: [inbound],
      skipDuplicates: true,
      select: { id: true },
    });
  });
  it('records a mock as preparation, never SENT or eligible for replay', async () => {
    expect(
      await sendAndLog(entry, async () => ({
        providerMessageId: 'mock-1',
        acceptedByProvider: false,
      }))
    ).toBe('PREPARED');
    expect(mocks.rows[0]).toMatchObject({
      status: 'IGNORED',
      providerMessageId: 'mock-1',
      error: 'MOCK_PREPARED',
    });
    const send = vi.fn();
    expect(await sendClaimedMessage(entry, 'log-1', send)).toBe('DUPLICATE');
    expect(send).not.toHaveBeenCalled();
  });
  it('commits unknown state before sending and records only explicit acceptance as SENT', async () => {
    expect(
      await sendAndLog(entry, async () => {
        expect(mocks.rows[0]).toMatchObject({
          status: 'PENDING',
          error: 'UNKNOWN_PROVIDER_OUTCOME',
        });
        return accepted;
      })
    ).toBe('SENT');
    expect(mocks.rows[0]).toMatchObject({
      status: 'SENT',
      providerMessageId: 'real-1',
      error: null,
    });
    expect(mocks.authority).toHaveBeenCalledWith({
      where: {
        id: 'log-1',
        organizationId: 'org-a',
        direction: 'OUTBOUND',
        dedupeKey: 'out:one',
        OR: [
          { status: 'PENDING', error: 'SEND_RESERVED' },
          {
            status: 'FAILED',
            error: { in: ['NOT_CONFIGURED', 'TEMPLATE_NOT_CONFIGURED', 'SEND_FAILED'] },
          },
        ],
      },
      data: { status: 'PENDING', error: 'UNKNOWN_PROVIDER_OUTCOME' },
    });
  });
  it.each([
    ['SENT', null],
    ['PENDING', null],
    ['PENDING', 'UNKNOWN_PROVIDER_OUTCOME'],
    ['FAILED', null],
    ['FAILED', 'UNKNOWN_PROVIDER_OUTCOME'],
    ['IGNORED', 'MOCK_PREPARED'],
  ] as const)('suppresses an existing %s / %s without send authority', async (status, error) => {
    existing(status, error);
    const send = vi.fn();
    expect(await sendClaimedMessage(entry, 'log-1', send)).toBe('DUPLICATE');
    expect(await sendAndLog(entry, send)).toBe('DUPLICATE');
    expect(send).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each([
    ['another tenant', { organizationId: 'org-b' }, 'log-1'],
    ['another key', { dedupeKey: 'out:other' }, 'log-1'],
    ['inbound direction', { direction: 'INBOUND' }, 'log-1'],
    ['another log id', {}, 'log-other'],
  ] as const)('never grants authority for %s', async (_label, extra, logId) => {
    existing('PENDING', 'SEND_RESERVED', extra);
    const send = vi.fn();
    expect(await sendClaimedMessage(entry, logId, send)).toBe('DUPLICATE');
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    new Error('private recipient and message'),
    new WhatsAppProviderError('SEND_FAILED', 'HTTP 503'),
  ])('keeps transport uncertainty pending and redacts arbitrary error details', async (error) => {
    expect(
      await sendAndLog(entry, async () => {
        throw error;
      })
    ).toBe('UNKNOWN');
    expect(mocks.rows[0]).toMatchObject({ status: 'PENDING', error: 'UNKNOWN_PROVIDER_OUTCOME' });
    const retry = vi.fn();
    expect(await sendClaimedMessage(entry, 'log-1', retry)).toBe('DUPLICATE');
    expect(retry).not.toHaveBeenCalled();
  });
  it.each([
    new WhatsAppProviderError('NOT_CONFIGURED'),
    new WhatsAppProviderError('TEMPLATE_NOT_CONFIGURED'),
    new WhatsAppProviderError('SEND_FAILED', 'HTTP 429', true),
  ])('allows exactly one retry after a definitive provider failure (%s)', async (error) => {
    expect(
      await sendAndLog(entry, async () => {
        throw error;
      })
    ).toBe('FAILED');
    expect(mocks.rows[0]).toMatchObject({ status: 'FAILED', error: error.reason });
    mocks.beforeAuthority = rendezvous(2);
    const send = vi.fn(async () => accepted);
    const outcomes = await Promise.all([
      sendClaimedMessage(entry, 'log-1', send),
      sendClaimedMessage(entry, 'log-1', send),
    ]);
    expect(outcomes.sort()).toEqual(['DUPLICATE', 'SENT']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(mocks.rows[0]).toMatchObject({ status: 'SENT', error: null });
  });
  it('fails closed on an uncertain authority commit before calling the provider', async () => {
    mocks.failAuthorityCommit = true;
    const send = vi.fn();
    await expect(sendAndLog(entry, send)).rejects.toThrow('authority commit uncertain');
    mocks.failAuthorityCommit = false;
    expect(await sendClaimedMessage(entry, 'log-1', send)).toBe('DUPLICATE');
    expect(send).not.toHaveBeenCalled();
  });
  it('never redelivers after acceptance even if the subsequent log write fails', async () => {
    mocks.update.mockRejectedValueOnce(new Error('database unavailable'));
    const send = vi.fn(async () => accepted);
    await expect(sendAndLog(entry, send)).rejects.toThrow('database unavailable');
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0][0].data.status).toBe('SENT');
    expect(mocks.rows[0]).toMatchObject({ status: 'PENDING', error: 'UNKNOWN_PROVIDER_OUTCOME' });
    expect(await sendClaimedMessage(entry, 'log-1', send)).toBe('DUPLICATE');
    expect(await sendAndLog(entry, send)).toBe('DUPLICATE');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('treats an unclassified adapter response as unknown and never retries it', async () => {
    expect(await sendAndLog(entry, async () => ({ providerMessageId: 'legacy' }))).toBe('UNKNOWN');
    const send = vi.fn();
    expect(await sendClaimedMessage(entry, 'log-1', send)).toBe('DUPLICATE');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('exclusive original and retry send authority', () => {
  it('serializes two retries of the same unattempted reservation at an explicit barrier', async () => {
    existing('PENDING', 'SEND_RESERVED');
    mocks.beforeAuthority = rendezvous(2);
    const entered = deferred();
    const release = deferred();
    const send = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return accepted;
    });
    const attempts = [
      sendClaimedMessage(entry, 'log-1', send),
      sendClaimedMessage(entry, 'log-1', send),
    ];
    await entered.promise;
    try {
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
    }
    expect((await Promise.all(attempts)).sort()).toEqual(['DUPLICATE', 'SENT']);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('uses the same gate when a retry overlaps the original sender before either can send', async () => {
    const originalAtGate = deferred();
    const bothAtGate = rendezvous(2);
    mocks.beforeAuthority = async () => {
      originalAtGate.resolve();
      await bothAtGate();
    };
    const send = vi.fn(async () => accepted);
    const original = sendAndLog(entry, send);
    await originalAtGate.promise;
    const retry = sendClaimedMessage(entry, 'log-1', send);
    expect((await Promise.all([original, retry])).sort()).toEqual(['DUPLICATE', 'SENT']);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('suppresses a retry while the original provider request is still in flight', async () => {
    const entered = deferred();
    const release = deferred();
    const send = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return accepted;
    });
    const original = sendAndLog(entry, send);
    await entered.promise;
    try {
      expect(await sendClaimedMessage(entry, 'log-1', send)).toBe('DUPLICATE');
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
    }
    expect(await original).toBe('SENT');
  });
  it('does not serialize or suppress unrelated tenants using the same dedupe key', async () => {
    existing('PENDING', 'SEND_RESERVED');
    const otherEntry = { ...entry, organizationId: 'org-b' };
    mocks.rows.push({
      ...otherEntry,
      id: 'log-2',
      direction: 'OUTBOUND',
      status: 'PENDING',
      error: 'SEND_RESERVED',
    });
    const bothProvidersEntered = rendezvous(2);
    const send = vi.fn(async () => {
      await bothProvidersEntered();
      return accepted;
    });
    expect(
      await Promise.all([
        sendClaimedMessage(entry, 'log-1', send),
        sendClaimedMessage(otherEntry, 'log-2', send),
      ])
    ).toEqual(['SENT', 'SENT']);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
