import { beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({ update: vi.fn(), authority: vi.fn(), tenants: [] as string[] }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: async (organizationId: string, fn: (db: unknown) => unknown) => {
    spies.tenants.push(organizationId);
    return fn({ pharmacyMessageLog: { update: spies.update, updateMany: spies.authority } });
  },
}));

import { sendClaimedMessage, updateMessageLog } from './message-log';

beforeEach(() => {
  spies.tenants.length = 0;
  spies.authority.mockReset().mockResolvedValue({ count: 1 });
  spies.update.mockReset().mockResolvedValue({ id: 'synthetic-log' });
});

describe('existing outbox outcome writer, without unrelated row hydration', () => {
  it('persists under the supplied tenant and requests only the ignored result id', async () => {
    await updateMessageLog('synthetic-tenant', 'synthetic-log', {
      status: 'IGNORED',
      error: 'MOCK_PREPARED',
    });
    expect(spies.tenants).toEqual(['synthetic-tenant']);
    expect(spies.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'synthetic-log' },
      data: { status: 'IGNORED', error: 'MOCK_PREPARED' },
      select: { id: true },
    });
  });

  it('preserves mock PREPARED as IGNORED, never SENT', async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ providerMessageId: 'synthetic-mock', acceptedByProvider: false });
    expect(
      await sendClaimedMessage(
        {
          organizationId: 'synthetic-tenant',
          kind: 'REFILL_REMINDER',
          dedupeKey: 'synthetic-dedupe',
        },
        'synthetic-log',
        send
      )
    ).toBe('PREPARED');
    expect(send).toHaveBeenCalledTimes(1);
    expect(spies.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'IGNORED', providerMessageId: 'synthetic-mock', error: 'MOCK_PREPARED' },
        select: { id: true },
      })
    );
  });

  it('requires explicit provider acceptance for SENT and propagates a failed persistence without replay', async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ providerMessageId: 'synthetic-accepted', acceptedByProvider: true });
    spies.update.mockRejectedValueOnce(new Error('synthetic persistence failure'));
    await expect(
      sendClaimedMessage(
        {
          organizationId: 'synthetic-tenant',
          kind: 'REFILL_REMINDER',
          dedupeKey: 'synthetic-dedupe',
        },
        'synthetic-log',
        send
      )
    ).rejects.toThrow('synthetic persistence failure');
    expect(send).toHaveBeenCalledTimes(1);
    expect(spies.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'synthetic-log' },
      data: { status: 'SENT', providerMessageId: 'synthetic-accepted', error: null },
      select: { id: true },
    });
  });

  it('keeps an ambiguous provider outcome PENDING with the fixed safe marker', async () => {
    expect(
      await sendClaimedMessage(
        {
          organizationId: 'synthetic-tenant',
          kind: 'REFILL_REMINDER',
          dedupeKey: 'synthetic-dedupe',
        },
        'synthetic-log',
        async () => ({ providerMessageId: 'synthetic-unknown' })
      )
    ).toBe('UNKNOWN');
    expect(spies.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: 'PENDING',
          providerMessageId: 'synthetic-unknown',
          error: 'UNKNOWN_PROVIDER_OUTCOME',
        },
        select: { id: true },
      })
    );
  });
});
