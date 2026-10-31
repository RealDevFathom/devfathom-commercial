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
  accounts: [] as Array<Record<string, unknown>>,
  customers: [] as Array<Record<string, unknown>>,
  consents: [] as ConsentRow[],
  logs: [] as LogRow[],
}));

vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: async () => ({}),
}));
vi.mock('../consent-writer', () => ({
  lockPatientConsent: async () => undefined,
}));
vi.mock('@/lib/tenancy/scoped-db', () => {
  const db = {
    $queryRaw: async (query: { sql: string }) =>
      query.sql.includes('pharmacy_family_accounts') ? store.accounts : [{ id: 'patient-1' }],
    organization: {
      findUnique: async () => ({
        vertical: 'PHARMACY',
        status: 'ACTIVE',
        timezone: 'Asia/Karachi',
      }),
    },
    pharmacyBranch: { findFirst: async () => ({ id: 'branch-1' }) },
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
      findFirst: async ({ where }: { where: { organizationId: string; dedupeKey: string; channel: string } }) =>
        store.logs.find(
          (log) => log.organizationId === where.organizationId &&
            log.dedupeKey === where.dedupeKey && (log.channel ?? 'WHATSAPP') === where.channel
        ) ?? null,
      count: async () => store.logs.length,
      createManyAndReturn: async ({ data }: { data: Array<Omit<LogRow, 'id'>> }) => {
        const row = data[0]!;
        if (
          store.logs.some(
            (log) =>
              log.organizationId === row.organizationId &&
              (log.dedupeKey === row.dedupeKey ||
                (row.customerDayKey && log.customerDayKey === row.customerDayKey))
          )
        )
          return [];
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
    withPlatformDb: (run: (tx: unknown) => unknown) => run(db),
    withTenantDb: (_organizationId: string, run: (tx: unknown) => unknown) => run(db),
  };
});

import { MockSmsProvider, readSmsConfig } from '../sms/provider';
import { processDueWhatsAppKhataReminders } from './khata-reminders';
import { MockWhatsAppProvider, readWhatsAppConfig, WhatsAppProviderError } from './provider';

const NOW = new Date('2026-10-21T08:00:00.000Z');
const BEFORE = new Date('2026-10-01T00:00:00.000Z');
const config = readWhatsAppConfig({
  PHARMACY_WHATSAPP_TEMPLATE_KHATA_REMINDER: 'khata_due_v1',
  PHARMACY_WHATSAPP_ORGANIZATION_ID: 'org_a',
  PHARMACY_WHATSAPP_PHONE_NUMBER_ID: 'sandbox-owner',
});
const smsConfig = readSmsConfig({ PHARMACY_SMS_ORGANIZATION_ID: 'org_a' });

function account() {
  return {
    familyAccountId: 'family-1',
    organizationId: 'org_a',
    branchId: 'branch-1',
    displayName: 'Khan household',
    payerCustomerId: 'customer-1',
    balanceMinor: 50_000,
    oldestOverdueAt: new Date('2026-10-10T00:00:00.000Z'),
  };
}

function customer(whatsappOptIn: boolean | null, smsOptIn: boolean | null = null) {
  return {
    id: 'customer-1',
    patientId: 'patient-1',
    active: true,
    whatsappOptIn,
    smsOptIn,
    patient: { phone: '0300-1234567' },
  };
}

function consent(channel: 'WHATSAPP' | 'SMS'): ConsentRow {
  return { patientId: 'patient-1', channel, granted: true, revokedAt: null, recordedAt: BEFORE };
}

beforeEach(() => {
  store.accounts = [account()];
  store.customers = [];
  store.consents = [];
  store.logs = [];
});

describe('processDueWhatsAppKhataReminders SMS fallback (#723)', () => {
  it('sends the khata reminder by SMS once per week when WhatsApp consent is missing', async () => {
    store.customers = [customer(false)];
    store.consents = [consent('SMS')];
    const provider = new MockWhatsAppProvider(config);
    const smsProvider = new MockSmsProvider(smsConfig);
    const run = () =>
      processDueWhatsAppKhataReminders({ now: NOW, config, provider, smsConfig, smsProvider });

    const first = await run();
    const second = await run();

    expect(first.sms).toMatchObject({ prepared: 1 });
    expect(second.sms).toMatchObject({ prepared: 0, duplicate: 1 });
    expect(provider.calls).toEqual([]);
    expect(smsProvider.calls).toHaveLength(1);
    expect(smsProvider.calls[0]!.body).toBe(
      'Khan household: Rs 500.00 is outstanding on your pharmacy account. Reply STOP to opt out.'
    );
    expect(store.logs[0]).toMatchObject({
      channel: 'SMS',
      kind: 'KHATA_REMINDER',
      customerDayKey: 'khata-sms:customer-1:2026-10-21',
    });
    expect(String(store.logs[0]!.dedupeKey)).toMatch(/^sms:khata:family-1:w\d+$/);
  });

  it('falls back to SMS only after a permanent WhatsApp failure', async () => {
    store.customers = [customer(true)];
    store.consents = [consent('WHATSAPP'), consent('SMS')];
    const failing = new MockWhatsAppProvider(config);
    failing.sendTemplate = async () => {
      throw new WhatsAppProviderError('SEND_FAILED', 'HTTP 400', true);
    };
    const smsProvider = new MockSmsProvider(smsConfig);

    const result = await processDueWhatsAppKhataReminders({
      now: NOW,
      config,
      provider: failing,
      smsConfig,
      smsProvider,
    });

    expect(result).toMatchObject({ failed: 1 });
    expect(result.sms).toMatchObject({ prepared: 1 });
    // The WhatsApp row keeps its own customer-day key; the SMS row has a separate one.
    expect(store.logs.map((log) => log.customerDayKey)).toEqual([
      'khata:customer-1:2026-10-21',
      'khata-sms:customer-1:2026-10-21',
    ]);
  });

  it('honours an SMS STOP and sends nothing', async () => {
    store.customers = [customer(null, false)];
    store.consents = [consent('SMS')];
    const smsProvider = new MockSmsProvider(smsConfig);

    const result = await processDueWhatsAppKhataReminders({
      now: NOW,
      config,
      provider: new MockWhatsAppProvider(config),
      smsConfig,
      smsProvider,
    });

    expect(result).toMatchObject({ skippedNoConsent: 1 });
    expect(smsProvider.calls).toEqual([]);
    expect(store.logs).toEqual([]);
  });

  it('never uses the SMS aggregator before it is approved', async () => {
    store.customers = [customer(null)];
    store.consents = [consent('SMS')];
    const live = readSmsConfig({
      PHARMACY_SMS_ORGANIZATION_ID: 'org_a',
      PHARMACY_SMS_PROVIDER: 'aggregator',
    });
    const smsProvider = new MockSmsProvider(live);

    const result = await processDueWhatsAppKhataReminders({
      now: NOW,
      config,
      provider: new MockWhatsAppProvider(config),
      smsConfig: live,
      smsProvider,
    });

    expect(result).toMatchObject({ skippedNoConsent: 1 });
    expect(smsProvider.calls).toEqual([]);
  });
});

it.each([
  readWhatsAppConfig({}),
  { ...config, templates: { ...config.templates, khataReminder: null } },
  { ...config, provider: 'meta' as const },
])('sends khata SMS independently of WhatsApp configuration: %j', async (whatsapp) => {
  store.customers = [customer(null)];
  store.consents = [consent('SMS')];
  const provider = new MockWhatsAppProvider(whatsapp);
  const smsProvider = new MockSmsProvider(smsConfig);
  const result = await processDueWhatsAppKhataReminders({ now: NOW, config: whatsapp, provider, smsConfig, smsProvider });
  expect(result.configured).toBe(true);
  expect(smsProvider.calls).toHaveLength(1);
  expect(provider.calls).toEqual([]);
});

it('falls back once for a permanent delivery failure recorded after the send', async () => {
  store.customers = [customer(true)];
  store.consents = [consent('WHATSAPP'), consent('SMS')];
  const provider = new MockWhatsAppProvider(config);
  const smsProvider = new MockSmsProvider(smsConfig);
  const run = () => processDueWhatsAppKhataReminders({ now: NOW, config, provider, smsConfig, smsProvider });
  await run();
  Object.assign(store.logs[0]!, { status: 'FAILED', error: 'WHATSAPP_DELIVERY_FAILED' });
  await run();
  await run();
  expect(provider.calls).toHaveLength(1);
  expect(smsProvider.calls).toHaveLength(1);
});
