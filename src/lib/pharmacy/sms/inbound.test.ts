import { beforeEach, describe, expect, it, vi } from 'vitest';

type LogRow = { id: string; dedupeKey: string; [key: string]: unknown };

const store = vi.hoisted(() => ({
  customer: null as null | {
    id: string;
    smsOptIn: boolean | null;
    smsOptInChangedAt: Date | null;
  },
  logs: [] as LogRow[],
}));

vi.mock('../consent-writer', () => ({ lockCustomerConsent: async () => undefined }));
vi.mock('../whatsapp/inbound', () => ({
  findCustomerByWhatsApp: async (_db: unknown, _org: string, from: string) =>
    store.customer && from === '923001234567'
      ? { id: store.customer.id, userId: null, active: true, whatsappOptIn: null }
      : null,
}));
vi.mock('@/lib/tenancy/scoped-db', () => {
  const db = {
    pharmacyCustomer: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { OR: Array<{ smsOptInChangedAt: null | Date | { lt: Date } }> };
        data: { smsOptIn: boolean; smsOptInChangedAt: Date };
      }) => {
        const current = store.customer!.smsOptInChangedAt;
        const allowed = where.OR.some((clause) => {
          const value = clause.smsOptInChangedAt;
          if (value === null) return current === null;
          if (value instanceof Date) return current?.getTime() === value.getTime();
          return current !== null && current < value.lt;
        });
        if (!allowed) return { count: 0 };
        Object.assign(store.customer!, data);
        return { count: 1 };
      },
    },
    pharmacyMessageLog: {
      createManyAndReturn: async ({ data }: { data: Array<Omit<LogRow, 'id'>> }) => {
        const row = data[0]!;
        if (store.logs.some((log) => log.dedupeKey === row.dedupeKey)) return [];
        const created = { ...row, id: `log-${store.logs.length + 1}` } as LogRow;
        store.logs.push(created);
        return [{ id: created.id }];
      },
      update: async ({ where, data }: { where: { id: string }; data: object }) => {
        const log = store.logs.find((row) => row.id === where.id)!;
        Object.assign(log, data);
        return log;
      },
    },
  };
  return { withTenantDb: (_organizationId: string, run: (tx: unknown) => unknown) => run(db) };
});

import { handleInboundSms } from './inbound';
import { MockSmsProvider, readSmsConfig } from './provider';

const NOW = new Date('2026-10-21T08:00:00.000Z');
const config = readSmsConfig({ PHARMACY_SMS_ORGANIZATION_ID: 'org_a' });

function message(id: string, text: string, receivedAt = new Date(NOW.getTime() - 60_000)) {
  return { providerMessageId: id, from: '923001234567', text, receivedAt };
}

beforeEach(() => {
  store.customer = { id: 'customer-1', smsOptIn: null, smsOptInChangedAt: null };
  store.logs = [];
});

describe('handleInboundSms (#723)', () => {
  it.each(['STOP', 'stop', 'Unsubscribe', 'band karo', 'بند کریں'])(
    'opts the customer out of SMS on %s and acknowledges by SMS',
    async (text) => {
      const provider = new MockSmsProvider(config);

      await expect(
        handleInboundSms('org_a', config, provider, message('m1', text), NOW)
      ).resolves.toBe('OPTED_OUT');

      expect(store.customer).toMatchObject({ smsOptIn: false });
      expect(store.logs[0]).toMatchObject({
        channel: 'SMS',
        direction: 'INBOUND',
        kind: 'OPT_OUT',
        dedupeKey: 'sms-in:m1',
        customerId: 'customer-1',
      });
      // The message text itself is never persisted.
      expect(JSON.stringify(store.logs)).not.toContain(text);
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0]!.body).toContain('START');
      expect(store.logs[1]).toMatchObject({ channel: 'SMS', kind: 'CONSENT_ACK' });
    }
  );

  it('opts back in on START after a STOP', async () => {
    const provider = new MockSmsProvider(config);
    await handleInboundSms(
      'org_a',
      config,
      provider,
      message('m1', 'STOP', new Date(NOW.getTime() - 120_000)),
      NOW
    );
    await expect(
      handleInboundSms('org_a', config, provider, message('m2', 'START'), NOW)
    ).resolves.toBe('OPTED_IN');
    expect(store.customer).toMatchObject({ smsOptIn: true });
  });

  it('ignores a replayed message id', async () => {
    const provider = new MockSmsProvider(config);
    await handleInboundSms('org_a', config, provider, message('m1', 'STOP'), NOW);
    await expect(
      handleInboundSms('org_a', config, provider, message('m1', 'STOP'), NOW)
    ).resolves.toBe('DUPLICATE');
    expect(provider.calls).toHaveLength(1);
  });

  it('does not let an older START override a newer STOP', async () => {
    const provider = new MockSmsProvider(config);
    await handleInboundSms('org_a', config, provider, message('m2', 'STOP'), NOW);
    await expect(
      handleInboundSms(
        'org_a',
        config,
        provider,
        message('m1', 'START', new Date(NOW.getTime() - 3_600_000)),
        NOW
      )
    ).resolves.toBe('STALE_CONSENT');
    expect(store.customer).toMatchObject({ smsOptIn: false });
  });

  it('still applies a STOP whose gateway timestamp is in the future', async () => {
    const provider = new MockSmsProvider(config);
    await expect(
      handleInboundSms(
        'org_a',
        config,
        provider,
        message('m1', 'STOP', new Date(NOW.getTime() + 60_000)),
        NOW
      )
    ).resolves.toBe('OPTED_OUT');
    expect(store.customer).toMatchObject({ smsOptIn: false, smsOptInChangedAt: NOW });
  });

  it('logs an unknown sender as ignored and changes nothing', async () => {
    const provider = new MockSmsProvider(config);
    await expect(
      handleInboundSms(
        'org_a',
        config,
        provider,
        { ...message('m1', 'STOP'), from: '923009999999' },
        NOW
      )
    ).resolves.toBe('UNKNOWN_SENDER');
    expect(store.logs[0]).toMatchObject({ status: 'IGNORED', error: 'UNKNOWN_SENDER' });
    expect(store.customer).toMatchObject({ smsOptIn: null });
    expect(provider.calls).toEqual([]);
  });

  it('ignores non-keyword text without persisting anything', async () => {
    const provider = new MockSmsProvider(config);
    await expect(
      handleInboundSms('org_a', config, provider, message('m1', 'panadol 2 pack'), NOW)
    ).resolves.toBe('IGNORED');
    expect(store.logs).toEqual([]);
    expect(provider.calls).toEqual([]);
  });
});
