import { beforeEach, describe, expect, it, vi } from 'vitest';

type LogRow = { id: string; organizationId: string; dedupeKey: string; [key: string]: unknown };
type ConsentRow = {
  patientId: string;
  purpose: string;
  channel: string;
  granted: boolean;
  revokedAt: Date | null;
  recordedAt: Date;
  version: number;
};

const store = vi.hoisted(() => ({
  captures: [] as Array<Record<string, unknown>>,
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
  // Row locking is covered by the message-log tests; consent writes append a version.
  lockPatientConsent: async () => undefined,
  lockCustomerConsent: async () => undefined,
  writePatientConsent: async (
    _db: unknown,
    _organizationId: string,
    _actor: string,
    input: { patientId: string; purpose: string; channel: string; granted: boolean },
    now: Date
  ) => {
    const version =
      Math.max(
        0,
        ...store.consents
          .filter(
            (row) =>
              row.patientId === input.patientId &&
              row.purpose === input.purpose &&
              row.channel === input.channel
          )
          .map((row) => row.version)
      ) + 1;
    store.consents.push({
      ...input,
      version,
      recordedAt: now,
      revokedAt: input.granted ? null : now,
    });
  },
}));
vi.mock('../whatsapp/inbound', () => ({
  findCustomerByWhatsApp: async (_db: unknown, _organizationId: string, waId: string) =>
    store.customers.find((customer) => customer.wa === waId) ?? null,
}));
vi.mock('@/lib/tenancy/scoped-db', () => {
  const db = {
    $queryRaw: async (query: { sql: string }) => {
      if (query.sql.includes('pharmacy_family_accounts')) return store.accounts;
      if (query.sql.includes('pharmacy_refill_reminder_captures')) return store.captures;
      return [{ id: 'locked' }];
    },
    organization: {
      findUnique: async () => ({ vertical: 'PHARMACY', status: 'ACTIVE', timezone: 'UTC' }),
    },
    pharmacyBranch: { findFirst: async () => ({ id: 'branch-1' }) },
    pharmacyCustomer: {
      findFirst: async ({ where }: { where: { id?: string; patientId?: string } }) =>
        store.customers.find((customer) =>
          where.id ? customer.id === where.id : customer.patientId === where.patientId
        ) ?? null,
    },
    patientConsent: {
      findFirst: async ({
        where,
      }: {
        where: { patientId: string; purpose: string; channel: string };
      }) =>
        store.consents
          .filter(
            (row) =>
              row.patientId === where.patientId &&
              row.purpose === where.purpose &&
              row.channel === where.channel
          )
          .sort((left, right) => right.version - left.version)[0] ?? null,
    },
    pharmacyMessageLog: {
      findFirst: async ({
        where,
      }: {
        where: {
          organizationId: string;
          direction: string;
          kind: string;
          dedupeKey: { in: string[] };
          createdAt: { gte: Date; lt: Date };
        };
      }) =>
        store.logs.find(
          (log) =>
            log.organizationId === where.organizationId &&
            log.direction === where.direction &&
            log.kind === where.kind &&
            where.dedupeKey.in.includes(log.dedupeKey) &&
            log.createdAt instanceof Date &&
            log.createdAt >= where.createdAt.gte &&
            log.createdAt < where.createdAt.lt
        ) ?? null,
      // All fixture logs fall inside the 24-hour window.
      count: async ({
        where,
      }: {
        where: { customerId: string; direction: string; kind: string; status?: { not: string } };
      }) =>
        store.logs.filter(
          (log) =>
            log.customerId === where.customerId &&
            log.direction === where.direction &&
            log.kind === where.kind &&
            (!where.status || log.status !== where.status.not)
        ).length,
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

import { processDueWhatsAppKhataReminders } from '../whatsapp/khata-reminders';
import {
  MockWhatsAppProvider,
  readWhatsAppConfig,
  WhatsAppProviderError,
  type WhatsAppProvider,
} from '../whatsapp/provider';
import { processDueWhatsAppRefillReminders } from '../whatsapp/refill-reminders';
import { handleInboundSmsMessage } from './inbound';
import { MockSmsProvider, readSmsConfig } from './provider';

// 30 tablets once daily from 2026-09-01: runs out 2026-10-01; 3-day lead window is open.
const NOW = new Date('2026-09-29T10:00:00.000Z');
const EARLIER = new Date('2026-09-01T09:00:00.000Z');
const whatsappConfig = readWhatsAppConfig({
  PHARMACY_WHATSAPP_TEMPLATE_REFILL_REMINDER: 'refill_due_v1',
  PHARMACY_WHATSAPP_TEMPLATE_KHATA_REMINDER_EN: 'khata_due_en',
  PHARMACY_WHATSAPP_ORGANIZATION_ID: 'org_a',
  PHARMACY_WHATSAPP_PHONE_NUMBER_ID: 'sandbox-owner',
});
const smsConfig = readSmsConfig({ PHARMACY_SMS_ORGANIZATION_ID: 'org_a' });

function customer(whatsappOptIn: boolean | null, preferredLanguage = 'en') {
  return {
    id: 'customer-1',
    patientId: 'patient-1',
    userId: null,
    wa: '923001234567',
    active: true,
    whatsappOptIn,
    preferredLanguage,
    patient: { phone: '0300-1234567' },
  };
}

function consent(channel: 'WHATSAPP' | 'SMS', granted = true, version = 1): ConsentRow {
  return {
    patientId: 'patient-1',
    purpose: 'REMINDERS',
    channel,
    granted,
    revokedAt: granted ? null : EARLIER,
    recordedAt: EARLIER,
    version,
  };
}

const refillCapture = {
  id: 'capture-1',
  organizationId: 'org_a',
  branchId: 'branch-1',
  patientId: 'patient-1',
  medicineId: 'medicine-1',
  medicineName: 'Panadol 500 mg',
  directionsEnglish: 'one tablet once daily',
  quantityDispensed: 30,
  dispensedAt: EARLIER,
};

function failingWhatsApp(definitive: boolean): WhatsAppProvider {
  const provider = new MockWhatsAppProvider(whatsappConfig);
  provider.sendTemplate = async () => {
    throw new WhatsAppProviderError('SEND_FAILED', 'HTTP 400', definitive);
  };
  return provider;
}

beforeEach(() => {
  store.captures = [refillCapture];
  store.accounts = [];
  store.customers = [];
  store.consents = [];
  store.logs = [];
});

describe('refill reminders with SMS fallback', () => {
  it('sends the refill by SMS when the customer has no WhatsApp consent but SMS consent', async () => {
    store.customers = [customer(null)];
    store.consents = [consent('SMS')];
    const whatsapp = new MockWhatsAppProvider(whatsappConfig);
    const sms = new MockSmsProvider(smsConfig);

    const result = await processDueWhatsAppRefillReminders({
      now: NOW,
      config: whatsappConfig,
      provider: whatsapp,
      smsConfig,
      smsProvider: sms,
    });

    expect(result).toMatchObject({ skippedNoConsent: 0, sms: { prepared: 1 } });
    expect(whatsapp.calls).toEqual([]);
    expect(sms.calls).toEqual([
      {
        to: '923001234567',
        body: 'Your refill is due on 2026-10-01. Please visit or call your pharmacy.\nReply STOP to opt out.',
      },
    ]);
    // Transactional only: the SMS never names the medicine.
    expect(sms.calls[0]!.body).not.toMatch(/panadol/i);
    expect(store.logs).toEqual([
      expect.objectContaining({
        channel: 'SMS',
        kind: 'REFILL_REMINDER',
        dedupeKey: 'sms:refill:patient-1:medicine-1:2026-10-01',
        refillCaptureId: 'capture-1',
        status: 'IGNORED',
        error: 'MOCK_PREPARED',
      }),
    ]);

    // A repeated run cannot send the SMS twice.
    await processDueWhatsAppRefillReminders({
      now: NOW,
      config: whatsappConfig,
      provider: whatsapp,
      smsConfig,
      smsProvider: sms,
    });
    expect(sms.calls).toHaveLength(1);
  });

  it.each([
    ['no SMS consent', [] as ConsentRow[]],
    ['revoked SMS consent', [consent('SMS', true, 1), consent('SMS', false, 2)]],
  ])('sends nothing on either channel with %s', async (_label, consents) => {
    store.customers = [customer(false)];
    store.consents = consents;
    const sms = new MockSmsProvider(smsConfig);

    const result = await processDueWhatsAppRefillReminders({
      now: NOW,
      config: whatsappConfig,
      provider: new MockWhatsAppProvider(whatsappConfig),
      smsConfig,
      smsProvider: sms,
    });

    expect(result).toMatchObject({ skippedNoConsent: 1, sms: { prepared: 0 } });
    expect(sms.calls).toEqual([]);
    expect(store.logs).toEqual([]);
  });

  it('does not use SMS when the sender is not bound to the organization', async () => {
    store.customers = [customer(null)];
    store.consents = [consent('SMS')];
    const unbound = readSmsConfig({ PHARMACY_SMS_ORGANIZATION_ID: 'org_b' });
    const sms = new MockSmsProvider(unbound);

    await processDueWhatsAppRefillReminders({
      now: NOW,
      config: whatsappConfig,
      provider: new MockWhatsAppProvider(whatsappConfig),
      smsConfig: unbound,
      smsProvider: sms,
    });
    expect(sms.calls).toEqual([]);
  });

  it('never sends SMS when WhatsApp consent exists and the send succeeds', async () => {
    store.customers = [customer(true)];
    store.consents = [consent('WHATSAPP'), consent('SMS')];
    const whatsapp = new MockWhatsAppProvider(whatsappConfig);
    const sms = new MockSmsProvider(smsConfig);

    await processDueWhatsAppRefillReminders({
      now: NOW,
      config: whatsappConfig,
      provider: whatsapp,
      smsConfig,
      smsProvider: sms,
    });
    expect(whatsapp.calls).toHaveLength(1);
    expect(sms.calls).toEqual([]);
  });

  it('falls back to SMS after a permanent WhatsApp failure only', async () => {
    store.customers = [customer(true)];
    store.consents = [consent('WHATSAPP'), consent('SMS')];
    const sms = new MockSmsProvider(smsConfig);

    const permanent = await processDueWhatsAppRefillReminders({
      now: NOW,
      config: whatsappConfig,
      provider: failingWhatsApp(true),
      smsConfig,
      smsProvider: sms,
    });
    expect(permanent).toMatchObject({ failed: 1, sms: { prepared: 1 } });
    expect(sms.calls).toHaveLength(1);

    store.logs = [];
    const transientSms = new MockSmsProvider(smsConfig);
    const transient = await processDueWhatsAppRefillReminders({
      now: NOW,
      config: whatsappConfig,
      provider: failingWhatsApp(false),
      smsConfig,
      smsProvider: transientSms,
    });
    expect(transient).toMatchObject({ unknown: 1, sms: { prepared: 0 } });
    expect(transientSms.calls).toEqual([]);
  });
});

describe('SMS fallback guards', () => {
  it('keeps the one-reminder-per-customer-per-day limit across medicines', async () => {
    store.captures = [
      refillCapture,
      { ...refillCapture, id: 'capture-2', medicineId: 'medicine-2' },
    ];
    store.customers = [customer(null)];
    store.consents = [consent('SMS')];
    const sms = new MockSmsProvider(smsConfig);

    await processDueWhatsAppRefillReminders({
      now: NOW,
      config: whatsappConfig,
      provider: new MockWhatsAppProvider(whatsappConfig),
      smsConfig,
      smsProvider: sms,
    });

    expect(sms.calls).toHaveLength(1);
    expect(store.logs).toHaveLength(1);
  });

  it('runs SMS-only when WhatsApp is not configured at all', async () => {
    store.customers = [customer(true)];
    store.consents = [consent('WHATSAPP'), consent('SMS')];
    const unconfigured = readWhatsAppConfig({});
    const whatsapp = new MockWhatsAppProvider(unconfigured);
    const sms = new MockSmsProvider(smsConfig);

    const refill = await processDueWhatsAppRefillReminders({
      now: NOW,
      config: unconfigured,
      provider: whatsapp,
      smsConfig,
      smsProvider: sms,
    });
    expect(refill).toMatchObject({ configured: false, scanned: 1, sms: { prepared: 1 } });

    store.captures = [];
    store.logs = [];
    store.accounts = [
      {
        familyAccountId: 'family-1',
        organizationId: 'org_a',
        branchId: 'branch-1',
        displayName: 'Khan family',
        payerCustomerId: 'customer-1',
        balanceMinor: 250_000,
        oldestOverdueAt: EARLIER,
      },
    ];
    const khata = await processDueWhatsAppKhataReminders({
      now: NOW,
      config: unconfigured,
      provider: whatsapp,
      smsConfig,
      smsProvider: sms,
    });
    expect(khata).toMatchObject({ configured: false, scanned: 1, sms: { prepared: 1 } });
    expect(whatsapp.calls).toEqual([]);
    expect(sms.calls).toHaveLength(2);
  });
});

describe('khata reminders with SMS fallback', () => {
  it('sends the Urdu khata SMS when WhatsApp consent is missing', async () => {
    store.captures = [];
    store.accounts = [
      {
        familyAccountId: 'family-1',
        organizationId: 'org_a',
        branchId: 'branch-1',
        displayName: 'Khan family',
        payerCustomerId: 'customer-1',
        balanceMinor: 250_000,
        oldestOverdueAt: EARLIER,
      },
    ];
    store.customers = [customer(null, 'ur')];
    store.consents = [consent('SMS')];
    const sms = new MockSmsProvider(smsConfig);

    const result = await processDueWhatsAppKhataReminders({
      now: NOW,
      config: whatsappConfig,
      provider: new MockWhatsAppProvider(whatsappConfig),
      smsConfig,
      smsProvider: sms,
    });

    expect(result).toMatchObject({ skippedNoConsent: 0, sms: { prepared: 1 } });
    expect(sms.calls).toHaveLength(1);
    expect(sms.calls[0]!.body).toContain('کھاتے');
    expect(sms.calls[0]!.body).toContain('2500.00');
    expect(sms.calls[0]!.body).toContain('بند کرنے کے لیے STOP لکھیں۔');
    expect(store.logs[0]).toMatchObject({ channel: 'SMS', kind: 'KHATA_REMINDER' });
  });
});

describe('inbound SMS STOP / START', () => {
  const stop = {
    providerMessageId: 'sms-1',
    from: '923001234567',
    text: 'STOP',
    receivedAt: new Date('2026-09-29T09:00:00.000Z'),
  };

  it('STOP withdraws SMS reminders and promotional consent, acknowledges, and blocks the fallback', async () => {
    store.customers = [customer(null)];
    store.consents = [
      consent('SMS'),
      { ...consent('SMS'), purpose: 'MARKETING' },
      { ...consent('WHATSAPP'), purpose: 'REMINDERS' },
    ];
    const sms = new MockSmsProvider(smsConfig);

    await expect(handleInboundSmsMessage('org_a', sms, stop, NOW)).resolves.toBe('OPTED_OUT');
    await expect(handleInboundSmsMessage('org_a', sms, stop, NOW)).resolves.toBe('DUPLICATE');

    const latest = (purpose: string, channel: string) =>
      store.consents
        .filter((row) => row.purpose === purpose && row.channel === channel)
        .sort((left, right) => right.version - left.version)[0];
    expect(latest('REMINDERS', 'SMS')).toMatchObject({ granted: false, version: 2 });
    expect(latest('MARKETING', 'SMS')).toMatchObject({ granted: false, version: 2 });
    // Service consent on another channel is untouched.
    expect(latest('REMINDERS', 'WHATSAPP')).toMatchObject({ granted: true, version: 1 });
    expect(sms.calls).toEqual([{ to: '923001234567', body: expect.stringContaining('START') }]);
    expect(store.logs).toEqual([
      expect.objectContaining({ channel: 'SMS', direction: 'INBOUND', kind: 'OPT_OUT' }),
      expect.objectContaining({ channel: 'SMS', direction: 'OUTBOUND', kind: 'CONSENT_ACK' }),
    ]);

    const reminders = new MockSmsProvider(smsConfig);
    const result = await processDueWhatsAppRefillReminders({
      now: NOW,
      config: whatsappConfig,
      provider: new MockWhatsAppProvider(whatsappConfig),
      smsConfig,
      smsProvider: reminders,
    });
    expect(result).toMatchObject({ skippedNoConsent: 1 });
    expect(reminders.calls).toEqual([]);
  });

  it('a delayed older START cannot override a newer STOP when consent was already withdrawn', async () => {
    store.customers = [customer(null)];
    store.consents = [consent('SMS', true, 1), consent('SMS', false, 2)];
    const sms = new MockSmsProvider(smsConfig);

    await expect(
      handleInboundSmsMessage(
        'org_a',
        sms,
        {
          ...stop,
          providerMessageId: 'sms-late-stop',
          receivedAt: new Date('2026-09-29T09:30:00Z'),
        },
        NOW
      )
    ).resolves.toBe('OPTED_OUT');
    await expect(
      handleInboundSmsMessage(
        'org_a',
        sms,
        {
          ...stop,
          providerMessageId: 'sms-early-start',
          text: 'START',
          receivedAt: new Date('2026-09-29T09:15:00Z'),
        },
        NOW
      )
    ).resolves.toBe('STALE_CONSENT');
    const latest = store.consents
      .filter((row) => row.purpose === 'REMINDERS' && row.channel === 'SMS')
      .sort((left, right) => right.version - left.version)[0];
    expect(latest).toMatchObject({ granted: false, version: 3 });
  });

  it('START re-grants SMS reminders only', async () => {
    store.customers = [customer(null)];
    store.consents = [consent('SMS', false)];
    const sms = new MockSmsProvider(smsConfig);

    await expect(
      handleInboundSmsMessage(
        'org_a',
        sms,
        { ...stop, providerMessageId: 'sms-2', text: 'start' },
        NOW
      )
    ).resolves.toBe('OPTED_IN');
    expect(store.consents.at(-1)).toMatchObject({
      purpose: 'REMINDERS',
      channel: 'SMS',
      granted: true,
      version: 2,
    });
    expect(store.consents.some((row) => row.purpose === 'MARKETING')).toBe(false);
  });

  it('ignores unknown senders and non-keyword text', async () => {
    const sms = new MockSmsProvider(smsConfig);
    await expect(handleInboundSmsMessage('org_a', sms, stop, NOW)).resolves.toBe('UNKNOWN_SENDER');
    store.customers = [customer(null)];
    await expect(
      handleInboundSmsMessage(
        'org_a',
        sms,
        { ...stop, providerMessageId: 'sms-3', text: 'hello' },
        NOW
      )
    ).resolves.toBe('IGNORED');
    expect(sms.calls).toEqual([]);
  });
});
