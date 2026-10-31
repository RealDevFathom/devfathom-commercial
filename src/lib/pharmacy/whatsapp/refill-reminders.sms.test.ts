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
  captures: [] as Array<Record<string, unknown>>,
  customers: [] as Array<Record<string, unknown>>,
  consents: [] as ConsentRow[],
  logs: [] as LogRow[],
}));

vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: async () => ({}),
}));
vi.mock('@/lib/tenancy/scoped-db', () => {
  const db = {
    $queryRaw: async (query: { sql: string }) =>
      query.sql.includes('FOR UPDATE') ? [{ id: 'patient-1' }] : store.captures,
    organization: {
      findUnique: async () => ({
        vertical: 'PHARMACY',
        status: 'ACTIVE',
        timezone: 'Asia/Karachi',
      }),
    },
    pharmacyBranch: { findFirst: async () => ({ id: 'branch-1' }) },
    pharmacyCustomer: {
      findFirst: async ({ where }: { where: { patientId?: string; id?: string } }) =>
        store.customers.find((customer) =>
          where.id ? customer.id === where.id : customer.patientId === where.patientId
        ) ?? null,
    },
    patientConsent: {
      findFirst: async ({ where }: { where: { patientId: string; channel: string } }) =>
        store.consents.find(
          (consent) => consent.patientId === where.patientId && consent.channel === where.channel
        ) ?? null,
    },
    pharmacyMessageLog: {
      count: async () => store.logs.length,
      createManyAndReturn: async ({ data }: { data: Array<Omit<LogRow, 'id'>> }) => {
        const row = data[0]!;
        if (
          store.logs.some(
            (log) =>
              log.organizationId === row.organizationId &&
              (log.dedupeKey === row.dedupeKey ||
                (row.customerDayKey !== undefined && log.customerDayKey === row.customerDayKey))
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

import { MockSmsProvider, readSmsConfig, SmsProviderError } from '../sms/provider';
import { MockWhatsAppProvider, readWhatsAppConfig, WhatsAppProviderError } from './provider';
import { processDueWhatsAppRefillReminders } from './refill-reminders';

const NOW = new Date('2026-09-29T08:00:00.000Z');
const BEFORE = new Date('2026-09-01T00:00:00.000Z');
const config = readWhatsAppConfig({
  PHARMACY_WHATSAPP_TEMPLATE_REFILL_REMINDER: 'refill_due_v1',
  PHARMACY_WHATSAPP_ORGANIZATION_ID: 'org_a',
  PHARMACY_WHATSAPP_PHONE_NUMBER_ID: 'sandbox-owner',
});
const smsConfig = readSmsConfig({ PHARMACY_SMS_ORGANIZATION_ID: 'org_a' });

function capture() {
  return {
    id: 'capture-1',
    organizationId: 'org_a',
    branchId: 'branch-1',
    patientId: 'patient-1',
    medicineId: 'medicine-1',
    medicineName: 'Panadol 500 mg',
    directionsEnglish: 'one tablet once daily',
    quantityDispensed: 30,
    dispensedAt: new Date('2026-09-01T09:00:00.000Z'),
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

function consent(channel: 'WHATSAPP' | 'SMS', granted = true): ConsentRow {
  return { patientId: 'patient-1', channel, granted, revokedAt: null, recordedAt: BEFORE };
}

class FailingWhatsApp extends MockWhatsAppProvider {
  constructor(private readonly error: Error) {
    super(config);
  }
  override async sendTemplate(): Promise<never> {
    throw this.error;
  }
}

beforeEach(() => {
  store.captures = [capture()];
  store.customers = [];
  store.consents = [];
  store.logs = [];
});

describe('processDueWhatsAppRefillReminders SMS fallback (#723)', () => {
  it('sends the refill reminder by SMS when the customer has no WhatsApp consent', async () => {
    store.customers = [customer(null)];
    store.consents = [consent('SMS')];
    const provider = new MockWhatsAppProvider(config);
    const smsProvider = new MockSmsProvider(smsConfig);

    const result = await processDueWhatsAppRefillReminders({
      now: NOW,
      config,
      provider,
      smsConfig,
      smsProvider,
    });

    expect(result).toMatchObject({ scanned: 1, prepared: 0, skippedNoConsent: 0 });
    expect(result.sms).toMatchObject({ prepared: 1, failed: 0 });
    expect(provider.calls).toEqual([]);
    expect(smsProvider.calls).toHaveLength(1);
    expect(smsProvider.calls[0]!.to).toBe('923001234567');
    expect(smsProvider.calls[0]!.body).toContain('2026-10-01');
    expect(smsProvider.calls[0]!.body).toContain('Reply STOP to opt out.');
    // Transactional only: the medicine name never appears in the SMS body.
    expect(smsProvider.calls[0]!.body).not.toContain('Panadol');
    expect(store.logs).toHaveLength(1);
    expect(store.logs[0]).toMatchObject({
      channel: 'SMS',
      kind: 'REFILL_REMINDER',
      direction: 'OUTBOUND',
      dedupeKey: 'sms:refill:patient-1:medicine-1:2026-10-01',
      // Per-customer, per-local-day cap on refill SMS.
      customerDayKey: expect.stringMatching(/^refill-sms:customer-1:\d{4}-\d{2}-\d{2}$/),
      refillCaptureId: 'capture-1',
      phoneLast4: '4567',
      status: 'IGNORED',
      error: 'MOCK_PREPARED',
    });
  });

  it('sends Urdu SMS when the Urdu template language is configured', async () => {
    store.customers = [customer(null)];
    store.consents = [consent('SMS')];
    const urdu = readSmsConfig({
      PHARMACY_SMS_ORGANIZATION_ID: 'org_a',
      PHARMACY_SMS_LANGUAGE: 'ur',
    });
    const smsProvider = new MockSmsProvider(urdu);

    await processDueWhatsAppRefillReminders({
      now: NOW,
      config,
      provider: new MockWhatsAppProvider(config),
      smsConfig: urdu,
      smsProvider,
    });

    expect(smsProvider.calls[0]!.body).toContain('STOP');
    expect(smsProvider.calls[0]!.body).toMatch(/[؀-ۿ]/);
  });

  it('never uses SMS when WhatsApp consent exists and WhatsApp succeeds', async () => {
    store.customers = [customer(true)];
    store.consents = [consent('WHATSAPP'), consent('SMS')];
    const provider = new MockWhatsAppProvider(config);
    const smsProvider = new MockSmsProvider(smsConfig);

    const result = await processDueWhatsAppRefillReminders({
      now: NOW,
      config,
      provider,
      smsConfig,
      smsProvider,
    });

    expect(result).toMatchObject({ prepared: 1 });
    expect(result.sms).toMatchObject({ sent: 0, prepared: 0 });
    expect(provider.calls).toHaveLength(1);
    expect(smsProvider.calls).toEqual([]);
  });

  it('falls back to SMS after a permanent WhatsApp failure', async () => {
    store.customers = [customer(true)];
    store.consents = [consent('WHATSAPP'), consent('SMS')];
    const smsProvider = new MockSmsProvider(smsConfig);

    const result = await processDueWhatsAppRefillReminders({
      now: NOW,
      config,
      provider: new FailingWhatsApp(new WhatsAppProviderError('SEND_FAILED', 'HTTP 400', true)),
      smsConfig,
      smsProvider,
    });

    expect(result).toMatchObject({ failed: 1 });
    expect(result.sms).toMatchObject({ prepared: 1 });
    expect(smsProvider.calls).toHaveLength(1);
    expect(store.logs.map((log) => [log.channel ?? 'WHATSAPP', log.status])).toEqual([
      ['WHATSAPP', 'FAILED'],
      ['SMS', 'IGNORED'],
    ]);
  });

  it('does not fall back on a transient or unknown WhatsApp outcome', async () => {
    store.customers = [customer(true)];
    store.consents = [consent('WHATSAPP'), consent('SMS')];
    const smsProvider = new MockSmsProvider(smsConfig);

    const result = await processDueWhatsAppRefillReminders({
      now: NOW,
      config,
      provider: new FailingWhatsApp(new WhatsAppProviderError('SEND_FAILED', 'HTTP 503')),
      smsConfig,
      smsProvider,
    });

    expect(result).toMatchObject({ unknown: 1, failed: 0 });
    expect(smsProvider.calls).toEqual([]);
    expect(store.logs).toHaveLength(1);
  });

  it.each([
    ['no SMS consent record', customer(null), []],
    ['SMS consent denied', customer(null), [consent('SMS', false)]],
    ['SMS consent revoked', customer(null), [{ ...consent('SMS'), revokedAt: BEFORE }]],
    ['customer replied STOP by SMS', customer(null, false), [consent('SMS')]],
  ])('sends nothing when %s', async (_label, row, consents) => {
    store.customers = [row];
    store.consents = consents as ConsentRow[];
    const smsProvider = new MockSmsProvider(smsConfig);

    const result = await processDueWhatsAppRefillReminders({
      now: NOW,
      config,
      provider: new MockWhatsAppProvider(config),
      smsConfig,
      smsProvider,
    });

    expect(result).toMatchObject({ scanned: 1, skippedNoConsent: 1 });
    expect(smsProvider.calls).toEqual([]);
    expect(store.logs).toEqual([]);
  });

  it('stays WhatsApp-only when the SMS sender is not bound to the tenant', async () => {
    store.customers = [customer(null)];
    store.consents = [consent('SMS')];
    const unbound = readSmsConfig({ PHARMACY_SMS_ORGANIZATION_ID: 'org_b' });
    const smsProvider = new MockSmsProvider(unbound);

    const result = await processDueWhatsAppRefillReminders({
      now: NOW,
      config,
      provider: new MockWhatsAppProvider(config),
      smsConfig: unbound,
      smsProvider,
    });

    expect(result).toMatchObject({ skippedNoConsent: 1 });
    expect(smsProvider.calls).toEqual([]);
  });

  it('records a permanent SMS gateway failure as FAILED without retrying WhatsApp', async () => {
    store.customers = [customer(null)];
    store.consents = [consent('SMS')];
    const smsProvider = new MockSmsProvider(smsConfig);
    smsProvider.sendText = async () => {
      throw new SmsProviderError('INVALID_RECIPIENT');
    };

    const result = await processDueWhatsAppRefillReminders({
      now: NOW,
      config,
      provider: new MockWhatsAppProvider(config),
      smsConfig,
      smsProvider,
    });

    expect(result.sms).toMatchObject({ failed: 1 });
    expect(store.logs[0]).toMatchObject({
      channel: 'SMS',
      status: 'FAILED',
      error: 'INVALID_RECIPIENT',
    });
  });

  it('claims the SMS reminder once across repeated runs', async () => {
    store.customers = [customer(null)];
    store.consents = [consent('SMS')];
    const smsProvider = new MockSmsProvider(smsConfig);
    const run = () =>
      processDueWhatsAppRefillReminders({
        now: NOW,
        config,
        provider: new MockWhatsAppProvider(config),
        smsConfig,
        smsProvider,
      });

    await run();
    const second = await run();

    // The fake log count makes the per-customer daily guard skip the second run.
    expect(second).toMatchObject({ skippedNoConsent: 1 });
    expect(smsProvider.calls).toHaveLength(1);
  });
});
