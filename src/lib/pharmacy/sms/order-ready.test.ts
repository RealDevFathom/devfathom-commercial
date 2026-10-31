import { beforeEach, describe, expect, it, vi } from 'vitest';

type LogRow = { id: string; organizationId: string; dedupeKey: string; [key: string]: unknown };
type ConsentRow = {
  patientId: string;
  channel: 'WHATSAPP' | 'SMS';
  granted: boolean;
  revokedAt: Date | null;
  recordedAt: Date;
};

const store = vi.hoisted(() => ({
  orderStatus: 'READY_FOR_COLLECTION',
  customers: [] as Array<Record<string, unknown>>,
  consents: [] as ConsentRow[],
  logs: [] as LogRow[],
  tenantCalls: [] as Array<{ organizationId: string; userId?: string }>,
  branchScopes: [] as unknown[],
}));

vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: async () => ({}),
}));
vi.mock('../consent-writer', () => ({ lockPatientConsent: async () => undefined }));
vi.mock('@/lib/tenancy/scoped-db', () => {
  const db = {
    $queryRaw: async (query: { sql: string; values: unknown[] }) => {
      if (query.sql.includes('app.current_branch_id')) store.branchScopes.push(query.values[0]);
      return [];
    },
    organization: {
      findUnique: async () => ({
        vertical: 'PHARMACY',
        status: 'ACTIVE',
        timezone: 'Asia/Karachi',
      }),
    },
    pharmacyBranch: { findFirst: async () => ({ name: 'Gulberg Branch' }) },
    pharmacyCustomerOrder: {
      findFirst: async () => ({ status: store.orderStatus, customerId: 'customer-1' }),
    },
    pharmacyCustomer: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        store.customers.find((customer) => customer.id === where.id) ?? null,
    },
    patientConsent: {
      findFirst: async ({ where }: { where: { patientId: string; channel: string } }) =>
        store.consents.find(
          (consent) => consent.patientId === where.patientId && consent.channel === where.channel
        ) ?? null,
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
  return {
    withTenantDb: (
      organizationId: string,
      run: (tx: unknown) => unknown,
      options: { userId?: string } = {}
    ) => {
      store.tenantCalls.push({ organizationId, userId: options.userId });
      return run(db);
    },
  };
});

import { notifyOrderReadyBySms, orderReference } from './order-ready';
import { MockSmsProvider, readSmsConfig } from './provider';

// 08:00 UTC = 13:00 in Karachi, inside the daytime window.
const NOW = new Date('2026-10-21T08:00:00.000Z');
const BEFORE = new Date('2026-10-01T00:00:00.000Z');
const smsConfig = readSmsConfig({ PHARMACY_SMS_ORGANIZATION_ID: 'org_a' });
const ORDER_ID = 'order_abcdef123456';

function customer(whatsappOptIn: boolean | null, smsOptIn: boolean | null = null) {
  return {
    id: 'customer-1',
    patientId: 'patient-1',
    active: true,
    whatsappOptIn,
    smsOptIn,
    patient: { phone: '+92 300 1234567' },
  };
}

function consent(channel: 'WHATSAPP' | 'SMS'): ConsentRow {
  return { patientId: 'patient-1', channel, granted: true, revokedAt: null, recordedAt: BEFORE };
}

function notify(smsProvider: MockSmsProvider, now = NOW, config = smsConfig) {
  return notifyOrderReadyBySms({
    organizationId: 'org_a',
    branchId: 'branch-1',
    orderId: ORDER_ID,
    actorUserId: 'staff-1',
    now,
    smsConfig: config,
    smsProvider,
  });
}

beforeEach(() => {
  store.orderStatus = 'READY_FOR_COLLECTION';
  store.customers = [];
  store.consents = [];
  store.logs = [];
  store.tenantCalls = [];
  store.branchScopes = [];
});

describe('notifyOrderReadyBySms (#723)', () => {
  it('announces a ready order by SMS once when the customer has no WhatsApp consent', async () => {
    store.customers = [customer(null)];
    store.consents = [consent('SMS')];
    const smsProvider = new MockSmsProvider(smsConfig);

    await expect(notify(smsProvider)).resolves.toBe('PREPARED');
    await expect(notify(smsProvider)).resolves.toBe('DUPLICATE');

    expect(smsProvider.calls).toEqual([
      {
        to: '923001234567',
        body: `Your order ${orderReference(ORDER_ID)} is ready for collection at Gulberg Branch. Reply STOP to opt out.`,
      },
    ]);
    expect(store.logs[0]).toMatchObject({
      channel: 'SMS',
      kind: 'ORDER_READY',
      orderId: ORDER_ID,
      branchId: 'branch-1',
      dedupeKey: `sms:order-ready:${ORDER_ID}`,
    });
    // Reads the RLS-protected order as the acting staff user, scoped to the branch.
    expect(store.tenantCalls[0]).toEqual({ organizationId: 'org_a', userId: 'staff-1' });
    expect(store.branchScopes[0]).toBe('branch-1');
  });

  it('sends nothing to a customer with WhatsApp consent (SMS is a fallback only)', async () => {
    store.customers = [customer(true)];
    store.consents = [consent('WHATSAPP'), consent('SMS')];
    const smsProvider = new MockSmsProvider(smsConfig);

    await expect(notify(smsProvider)).resolves.toBe('WHATSAPP_CONSENTED');
    expect(smsProvider.calls).toEqual([]);
    expect(store.logs).toEqual([]);
  });

  it.each([
    ['no SMS consent', customer(null), [] as ConsentRow[]],
    ['an SMS STOP', customer(null, false), [consent('SMS')]],
  ])('sends nothing with %s', async (_label, row, consents) => {
    store.customers = [row];
    store.consents = consents;
    const smsProvider = new MockSmsProvider(smsConfig);

    await expect(notify(smsProvider)).resolves.toBe('NO_SMS_CONSENT');
    expect(smsProvider.calls).toEqual([]);
    expect(store.logs).toEqual([]);
  });

  it('skips an order that is not READY_FOR_COLLECTION', async () => {
    store.customers = [customer(null)];
    store.consents = [consent('SMS')];
    store.orderStatus = 'COMPLETED';
    const smsProvider = new MockSmsProvider(smsConfig);

    await expect(notify(smsProvider)).resolves.toBe('NOT_ELIGIBLE');
    expect(smsProvider.calls).toEqual([]);
  });

  it('does not send during quiet hours', async () => {
    store.customers = [customer(null)];
    store.consents = [consent('SMS')];
    const smsProvider = new MockSmsProvider(smsConfig);

    // 18:00 UTC = 23:00 in Karachi.
    await expect(notify(smsProvider, new Date('2026-10-21T18:00:00.000Z'))).resolves.toBe(
      'QUIET_HOURS'
    );
    expect(smsProvider.calls).toEqual([]);
  });

  it('does nothing until the SMS sender is bound to this organization', async () => {
    const smsProvider = new MockSmsProvider(readSmsConfig({}));
    await expect(notify(smsProvider, NOW, readSmsConfig({}))).resolves.toBe('NOT_CONFIGURED');
    await expect(
      notify(smsProvider, NOW, readSmsConfig({ PHARMACY_SMS_ORGANIZATION_ID: 'org_b' }))
    ).resolves.toBe('NOT_CONFIGURED');
    expect(store.tenantCalls).toEqual([]);
  });
});
