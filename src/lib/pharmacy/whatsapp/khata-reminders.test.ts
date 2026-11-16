import { beforeEach, describe, expect, it, vi } from 'vitest';

type LogRow = { id: string; organizationId: string; dedupeKey: string; [key: string]: unknown };

const store = vi.hoisted(() => ({
  accounts: [] as Array<Record<string, unknown>>,
  customers: [] as Array<Record<string, unknown>>,
  consents: [] as Array<Record<string, unknown>>,
  logs: [] as LogRow[],
  catalog: [] as string[],
  audits: [] as Array<Record<string, unknown>>,
  /** The workspace zone the organization row holds. */
  timezone: 'Asia/Karachi',
  /** The branch row the job reads: DEV-76 schedule switch and merchant details. */
  branch: { id: 'branch-1' } as Record<string, unknown>,
  scanSql: [] as string[],
}));

vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: async () => ({}),
}));
vi.mock('../consent-writer', () => ({
  // Consent row locking is covered by the message-log tests.
  lockPatientConsent: async () => undefined,
  lockCustomerConsent: async () => undefined,
}));
vi.mock('@/lib/tenancy/scoped-db', () => {
  const db = {
    // The scan query returns candidate accounts; any other raw query is a row lock.
    $queryRaw: async (query: { sql: string }) => {
      if (!query.sql.includes('pharmacy_family_accounts')) return [{ id: 'patient-1' }];
      store.scanSql.push(query.sql);
      return store.accounts;
    },
    organization: {
      findUnique: async () => ({
        vertical: 'PHARMACY',
        status: 'ACTIVE',
        timezone: store.timezone,
      }),
    },
    pharmacyBranch: { findFirst: async () => store.branch },
    medicine: {
      findMany: async () =>
        store.catalog.map((productName, index) => ({ id: `m${index}`, productName })),
    },
    medicineAlias: { findMany: async () => [] },
    ingredient: { findMany: async () => [] },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        store.audits.push(data);
        return data;
      },
    },
    pharmacyCustomer: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        store.customers.find((customer) => customer.id === where.id) ?? null,
    },
    patientConsent: {
      findFirst: async ({ where }: { where: { patientId: string } }) =>
        store.consents.find((consent) => consent.patientId === where.patientId) ?? null,
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

import { MockWhatsAppProvider, readWhatsAppConfig } from './provider';
import {
  formatKhataDueDate,
  planKhataReminder,
  processDueWhatsAppKhataReminders,
  readDueKhataAccounts,
  sanitizeReminderDisplayName,
} from './khata-reminders';

const NOW = new Date('2026-10-21T08:00:00.000Z');
const config = readWhatsAppConfig({
  PHARMACY_WHATSAPP_TEMPLATE_KHATA_REMINDER: 'khata_due_v1',
  PHARMACY_WHATSAPP_ORGANIZATION_ID: 'org_a',
  PHARMACY_WHATSAPP_PHONE_NUMBER_ID: 'sandbox-owner',
});

function account(id = 'family-1') {
  return {
    familyAccountId: id,
    organizationId: 'org_a',
    branchId: 'branch-1',
    displayName: 'Khan household',
    payerCustomerId: 'customer-1',
    balanceMinor: 50_000,
    oldestOverdueAt: new Date('2026-10-10T00:00:00.000Z'),
  };
}

function customer(whatsappOptIn: boolean | null, preferredLanguage: 'en' | 'ur' = 'en') {
  return {
    id: 'customer-1',
    patientId: 'patient-1',
    active: true,
    whatsappOptIn,
    preferredLanguage,
    patient: { phone: '0300-1234567' },
  };
}

beforeEach(() => {
  store.accounts = [];
  store.customers = [];
  store.consents = [];
  store.logs = [];
  store.catalog = [];
  store.audits = [];
  store.timezone = 'Asia/Karachi';
  store.branch = { id: 'branch-1' };
  store.scanSql = [];
});

describe('planKhataReminder', () => {
  it('is due for an overdue balance at or above the floor', () => {
    const plan = planKhataReminder(
      { familyAccountId: 'family-1', balanceMinor: 50_000, oldestOverdueAt: NOW },
      NOW
    );
    expect(plan).toMatchObject({ due: true, dueDate: '2026-10-21' });
    expect(plan.dedupeKey).toMatch(/^khata:family-1:w\d+$/);
  });

  it('is not due without an overdue charge, below the floor, or in the future', () => {
    expect(
      planKhataReminder({ familyAccountId: 'f', balanceMinor: 50_000, oldestOverdueAt: null }, NOW)
        .due
    ).toBe(false);
    expect(
      planKhataReminder({ familyAccountId: 'f', balanceMinor: 5_000, oldestOverdueAt: NOW }, NOW)
        .due
    ).toBe(false);
    expect(
      planKhataReminder(
        {
          familyAccountId: 'f',
          balanceMinor: 50_000,
          oldestOverdueAt: new Date(NOW.getTime() + 86_400_000),
        },
        NOW
      ).due
    ).toBe(false);
  });

  it('buckets the dedupe key by account x week', () => {
    const base = planKhataReminder(
      { familyAccountId: 'family-1', balanceMinor: 50_000, oldestOverdueAt: NOW },
      NOW
    );
    const sameInstant = planKhataReminder(
      { familyAccountId: 'family-1', balanceMinor: 50_000, oldestOverdueAt: NOW },
      NOW
    );
    const nextWeek = planKhataReminder(
      { familyAccountId: 'family-1', balanceMinor: 50_000, oldestOverdueAt: NOW },
      new Date(NOW.getTime() + 7 * 86_400_000)
    );
    expect(sameInstant.dedupeKey).toBe(base.dedupeKey);
    expect(nextWeek.dedupeKey).not.toBe(base.dedupeKey);
  });
});

describe('processDueWhatsAppKhataReminders', () => {
  it('sends once per family account per week across repeated runs', async () => {
    store.accounts = [account()];
    store.customers = [customer(true)];
    store.consents = [{ patientId: 'patient-1', granted: true, revokedAt: null }];
    const provider = new MockWhatsAppProvider(config);

    const first = await processDueWhatsAppKhataReminders({ now: NOW, config, provider });
    const second = await processDueWhatsAppKhataReminders({ now: NOW, config, provider });

    expect(first).toMatchObject({
      scanned: 1,
      sent: 0,
      prepared: 1,
      failed: 0,
      skippedNoConsent: 0,
    });
    expect(second).toMatchObject({ scanned: 1, sent: 0, duplicate: 1 });
    expect(provider.calls).toEqual([
      {
        kind: 'template',
        to: '923001234567',
        template: 'khataReminder',
        templateName: 'khata_due_v1',
        language: 'en',
        parameters: ['Khan household', '500.00'],
      },
    ]);
    expect(store.logs).toHaveLength(1);
    expect(store.logs[0]).toMatchObject({
      kind: 'KHATA_REMINDER',
      direction: 'OUTBOUND',
      status: 'IGNORED',
      phoneLast4: '4567',
      dueDate: '2026-10-10',
    });
  });

  it.each([
    ['never asked (null opt-in)', null, { granted: true, revokedAt: null }],
    ['opted out via STOP', false, { granted: true, revokedAt: null }],
    ['opted in but REMINDERS consent revoked', true, { granted: true, revokedAt: NOW }],
    ['opted in but REMINDERS consent denied', true, { granted: false, revokedAt: null }],
    ['opted in without a REMINDERS consent record', true, null],
  ])('sends nothing when %s', async (_label, optIn, consent) => {
    store.accounts = [account()];
    store.customers = [customer(optIn)];
    store.consents = consent ? [{ patientId: 'patient-1', ...consent }] : [];
    const provider = new MockWhatsAppProvider(config);

    const result = await processDueWhatsAppKhataReminders({ now: NOW, config, provider });

    expect(result).toMatchObject({ scanned: 1, sent: 0, skippedNoConsent: 1 });
    expect(provider.calls).toEqual([]);
    expect(store.logs).toEqual([]);
  });

  it('reads the send window and the day in UTC for a stored zone Intl refuses, instead of failing the run', async () => {
    // 09:00 UTC is inside the 09:00-22:00 send window in UTC.
    store.timezone = 'PKT';
    store.accounts = [account()];
    store.customers = [customer(true)];
    store.consents = [{ patientId: 'patient-1', granted: true, revokedAt: null }];
    const provider = new MockWhatsAppProvider(config);

    await expect(
      processDueWhatsAppKhataReminders({ now: new Date('2026-10-21T09:00:00Z'), config, provider })
    ).resolves.toMatchObject({ scanned: 1, prepared: 1, failed: 0 });
    expect(provider.calls).toHaveLength(1);
    expect(store.logs[0]).toMatchObject({ customerDayKey: 'khata:customer-1:2026-10-21' });
  });

  it('does nothing until the reminder template name is configured', async () => {
    store.accounts = [account()];
    const provider = new MockWhatsAppProvider(readWhatsAppConfig({}));
    const result = await processDueWhatsAppKhataReminders({
      now: NOW,
      config: readWhatsAppConfig({}),
      provider,
    });
    expect(result).toMatchObject({ configured: false, scanned: 0 });
    expect(provider.calls).toEqual([]);
    expect(result.configurationErrors).toContain('KHATA_TEMPLATES_NOT_CONFIGURED');
  });

  it('reports configured false when Meta credentials are absent', async () => {
    const metaConfig = readWhatsAppConfig({
      PHARMACY_WHATSAPP_PROVIDER: 'meta',
      PHARMACY_WHATSAPP_ORGANIZATION_ID: 'org_a',
      PHARMACY_WHATSAPP_PHONE_NUMBER_ID: 'owner-number',
      PHARMACY_WHATSAPP_TEMPLATE_KHATA_REMINDER_EN: 'khata_due_en',
    });
    const result = await processDueWhatsAppKhataReminders({ now: NOW, config: metaConfig });
    expect(result).toMatchObject({ configured: false, scanned: 0 });
    expect(result.configurationErrors).toContain('ACCESS_TOKEN_NOT_CONFIGURED');
  });

  it('uses the persisted Urdu preference and its explicitly configured parameter order', async () => {
    const urduConfig = readWhatsAppConfig({
      PHARMACY_WHATSAPP_ORGANIZATION_ID: 'org_a',
      PHARMACY_WHATSAPP_PHONE_NUMBER_ID: 'sandbox-owner',
      PHARMACY_WHATSAPP_TEMPLATE_KHATA_REMINDER_EN: 'khata_due_en',
      PHARMACY_WHATSAPP_TEMPLATE_KHATA_REMINDER_UR: 'khata_due_ur',
      PHARMACY_WHATSAPP_TEMPLATE_KHATA_REMINDER_UR_PARAMETERS: 'balance,name',
    });
    store.accounts = [account()];
    store.customers = [customer(true, 'ur')];
    store.consents = [{ patientId: 'patient-1', granted: true, revokedAt: null }];
    const provider = new MockWhatsAppProvider(urduConfig);

    const result = await processDueWhatsAppKhataReminders({
      now: NOW,
      config: urduConfig,
      provider,
    });

    expect(result).toMatchObject({ configured: true, prepared: 1, skippedConfiguration: 0 });
    expect(provider.calls[0]).toMatchObject({
      templateName: 'khata_due_ur',
      language: 'ur',
      parameters: ['500.00', 'Khan household'],
    });
  });

  it('accepts an Urdu-only template with an explicit parameter contract', async () => {
    const urduConfig = readWhatsAppConfig({
      PHARMACY_WHATSAPP_ORGANIZATION_ID: 'org_a',
      PHARMACY_WHATSAPP_PHONE_NUMBER_ID: 'sandbox-owner',
      PHARMACY_WHATSAPP_TEMPLATE_KHATA_REMINDER_UR: 'khata_due_ur',
      PHARMACY_WHATSAPP_TEMPLATE_KHATA_REMINDER_UR_PARAMETERS: 'name,balance',
    });
    store.accounts = [account()];
    store.customers = [customer(true, 'ur')];
    store.consents = [{ patientId: 'patient-1', granted: true, revokedAt: null }];
    const provider = new MockWhatsAppProvider(urduConfig);

    const result = await processDueWhatsAppKhataReminders({
      now: NOW,
      config: urduConfig,
      provider,
    });

    expect(result).toMatchObject({ configured: true, scanned: 1, prepared: 1 });
    expect(provider.calls[0]).toMatchObject({
      templateName: 'khata_due_ur',
      language: 'ur',
      parameters: ['Khan household', '500.00'],
    });
  });

  it('fails closed for Urdu when its approved template or parameter contract is absent', async () => {
    store.accounts = [account()];
    store.customers = [customer(true, 'ur')];
    store.consents = [{ patientId: 'patient-1', granted: true, revokedAt: null }];
    const provider = new MockWhatsAppProvider(config);

    const result = await processDueWhatsAppKhataReminders({ now: NOW, config, provider });

    expect(result).toMatchObject({ configured: true, scanned: 1, skippedConfiguration: 1 });
    expect(result.configurationErrors).toContain('KHATA_TEMPLATE_UR_NOT_CONFIGURED');
    expect(provider.calls).toEqual([]);
    expect(store.logs).toEqual([]);
  });

  it('fails closed before scanning when no template has a valid parameter contract', async () => {
    const invalidConfig = readWhatsAppConfig({
      PHARMACY_WHATSAPP_ORGANIZATION_ID: 'org_a',
      PHARMACY_WHATSAPP_PHONE_NUMBER_ID: 'sandbox-owner',
      PHARMACY_WHATSAPP_TEMPLATE_KHATA_REMINDER_EN: 'khata_due_en',
      PHARMACY_WHATSAPP_TEMPLATE_KHATA_REMINDER_EN_PARAMETERS: 'name,amount',
    });
    store.accounts = [account()];
    store.customers = [customer(true)];
    store.consents = [{ patientId: 'patient-1', granted: true, revokedAt: null }];
    const provider = new MockWhatsAppProvider(invalidConfig);

    const result = await processDueWhatsAppKhataReminders({
      now: NOW,
      config: invalidConfig,
      provider,
    });

    expect(result).toMatchObject({ configured: false, scanned: 0, skippedConfiguration: 0 });
    expect(result.configurationErrors).toContain('KHATA_TEMPLATES_NOT_CONFIGURED');
    expect(provider.calls).toEqual([]);
    expect(store.logs).toEqual([]);
  });

  it('allows a fully configured Meta job to use its injected adapter and records acceptance', async () => {
    const metaConfig = readWhatsAppConfig({
      PHARMACY_WHATSAPP_PROVIDER: 'meta',
      PHARMACY_WHATSAPP_LIVE_SEND: 'approved',
      PHARMACY_WHATSAPP_ACCESS_TOKEN: 'test-token',
      PHARMACY_WHATSAPP_ORGANIZATION_ID: 'org_a',
      PHARMACY_WHATSAPP_PHONE_NUMBER_ID: 'owner-number',
      PHARMACY_WHATSAPP_TEMPLATE_KHATA_REMINDER_EN: 'khata_due_en',
    });
    store.accounts = [account()];
    store.customers = [customer(true)];
    store.consents = [{ patientId: 'patient-1', granted: true, revokedAt: null }];
    const sendTemplate = vi.fn().mockResolvedValue({
      providerMessageId: 'wamid.accepted',
      acceptedByProvider: true,
    });
    const provider = {
      name: 'meta' as const,
      sendTemplate,
      sendText: vi.fn(),
      verifyWebhook: vi.fn(),
      parseInbound: vi.fn(),
    };

    const first = await processDueWhatsAppKhataReminders({
      now: NOW,
      config: metaConfig,
      provider,
    });
    const retry = await processDueWhatsAppKhataReminders({
      now: NOW,
      config: metaConfig,
      provider,
    });

    expect(first).toMatchObject({ configured: true, sent: 1 });
    expect(retry).toMatchObject({ duplicate: 1, sent: 0 });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
  });

  it('reports configured false for Meta without explicit owner live-send approval', async () => {
    const metaConfig = readWhatsAppConfig({
      PHARMACY_WHATSAPP_PROVIDER: 'meta',
      PHARMACY_WHATSAPP_ACCESS_TOKEN: 'test-token',
      PHARMACY_WHATSAPP_ORGANIZATION_ID: 'org_a',
      PHARMACY_WHATSAPP_PHONE_NUMBER_ID: 'owner-number',
      PHARMACY_WHATSAPP_TEMPLATE_KHATA_REMINDER_EN: 'khata_due_en',
    });
    store.accounts = [account()];
    store.customers = [customer(true)];
    store.consents = [{ patientId: 'patient-1', granted: true, revokedAt: null }];
    const sendTemplate = vi.fn();

    const result = await processDueWhatsAppKhataReminders({
      now: NOW,
      config: metaConfig,
      provider: {
        name: 'meta',
        sendTemplate,
        sendText: vi.fn(),
        verifyWebhook: vi.fn(),
        parseInbound: vi.fn(),
      },
    });

    expect(result).toMatchObject({ configured: false, scanned: 0 });
    expect(result.configurationErrors).toContain('LIVE_SEND_NOT_APPROVED');
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(store.logs).toEqual([]);
  });

  it('counts an unsupported stored language as a configuration skip, not missing consent', async () => {
    store.accounts = [account()];
    store.customers = [{ ...customer(true), preferredLanguage: 'fr' }];
    store.consents = [{ patientId: 'patient-1', granted: true, revokedAt: null }];
    const provider = new MockWhatsAppProvider(config);

    const result = await processDueWhatsAppKhataReminders({ now: NOW, config, provider });

    expect(result).toMatchObject({ skippedConfiguration: 1, skippedNoConsent: 0, prepared: 0 });
    expect(result.configurationErrors).toContain('KHATA_LANGUAGE_UNSUPPORTED');
    expect(provider.calls).toEqual([]);
    expect(store.logs).toEqual([]);
  });

  it('preserves quiet hours without claiming or sending', async () => {
    store.timezone = 'Asia/Karachi';
    store.accounts = [account()];
    store.customers = [customer(true)];
    store.consents = [{ patientId: 'patient-1', granted: true, revokedAt: null }];
    const provider = new MockWhatsAppProvider(config);
    const result = await processDueWhatsAppKhataReminders({
      now: new Date('2026-10-21T20:00:00Z'),
      config,
      provider,
    });
    expect(result).toMatchObject({ skippedQuietHours: 1, skippedNoConsent: 0, prepared: 0 });
    expect(provider.calls).toEqual([]);
    expect(store.logs).toEqual([]);
  });
});

describe('reminder text and daily customer dedupe', () => {
  it('strips links and newlines, caps names, and supplies an empty-name fallback', () => {
    expect(
      sanitizeReminderDisplayName('Khan\r\nhttps://evil.test/a www.evil.test evil.test/path Family')
    ).toBe('Khan Family');
    expect(sanitizeReminderDisplayName('A'.repeat(90))).toHaveLength(40);
    expect(sanitizeReminderDisplayName('https://evil.test')).toBe('Family account');
  });
  it('claims one daily slot across two accounts, branches and concurrent runs', async () => {
    store.accounts = [account(), { ...account('family-2'), branchId: 'branch-2' }];
    store.customers = [customer(true)];
    store.consents = [{ patientId: 'patient-1', granted: true, revokedAt: null }];
    const provider = new MockWhatsAppProvider(config);
    await Promise.all([
      processDueWhatsAppKhataReminders({ now: NOW, config, provider }),
      processDueWhatsAppKhataReminders({ now: NOW, config, provider }),
    ]);
    expect(provider.calls).toHaveLength(1);
    expect(store.logs[0].customerDayKey).toBe('khata:customer-1:2026-10-21');
    await processDueWhatsAppKhataReminders({
      now: new Date('2026-10-22T08:00:00Z'),
      config,
      provider,
    });
    expect(provider.calls).toHaveLength(2);
  });
  it('sends the sanitized name to the provider', async () => {
    store.accounts = [{ ...account(), displayName: 'Khan\nhttps://evil.test' }];
    store.customers = [customer(true)];
    store.consents = [{ patientId: 'patient-1', granted: true, revokedAt: null }];
    const provider = new MockWhatsAppProvider(config);
    await processDueWhatsAppKhataReminders({ now: NOW, config, provider });
    expect(provider.calls[0]).toMatchObject({ parameters: ['Khan', '500.00'] });
  });
});

describe('DEV-29 send-time variable compliance re-check', () => {
  it.each([
    ['a catalogue brand', 'Zyrtecin Family', ['Zyrtecin 10mg Tablet']],
    ['a static salt with a misspelling', 'Paracitamol Wala', []],
    ['a static brand written in Urdu script', 'پیناڈول والے', []],
  ])('blocks a display name naming %s and logs the block', async (_label, displayName, catalog) => {
    store.catalog = catalog;
    store.accounts = [{ ...account(), displayName }];
    store.customers = [customer(true)];
    store.consents = [{ patientId: 'patient-1', granted: true, revokedAt: null }];
    const provider = new MockWhatsAppProvider(config);
    const result = await processDueWhatsAppKhataReminders({ now: NOW, config, provider });
    expect(provider.calls).toHaveLength(0);
    expect(store.logs).toHaveLength(0);
    expect(result).toMatchObject({
      sent: 0,
      skippedConfiguration: 1,
      configurationErrors: ['WHATSAPP_COMPLIANCE_BLOCKED'],
    });
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      action: 'pharmacy.whatsappCompliance.blocked',
      actorType: 'SYSTEM',
      targetType: 'KHATA_REMINDER',
      targetId: 'family-1',
      outcome: 'FAILURE',
      metadata: {
        linterVersion: 'wa-compliance-lint-v1',
        outcome: 'BLOCK',
        reasons: [expect.objectContaining({ source: 'VARIABLE', index: 0, outcome: 'BLOCK' })],
      },
    });
    // The raw variable value is never logged.
    expect(JSON.stringify(store.audits[0])).not.toContain(displayName);
  });
  it('sends an ordinary display name without a log row', async () => {
    store.catalog = ['Zyrtecin 10mg Tablet'];
    store.accounts = [{ ...account(), displayName: 'Khan Family' }];
    store.customers = [customer(true)];
    store.consents = [{ patientId: 'patient-1', granted: true, revokedAt: null }];
    const provider = new MockWhatsAppProvider(config);
    await processDueWhatsAppKhataReminders({ now: NOW, config, provider });
    expect(provider.calls).toHaveLength(1);
    expect(store.audits).toHaveLength(0);
  });
});

describe('DEV-76 khata collection reminders', () => {
  const fullConfig = readWhatsAppConfig({
    PHARMACY_WHATSAPP_ORGANIZATION_ID: 'org_a',
    PHARMACY_WHATSAPP_PHONE_NUMBER_ID: 'sandbox-owner',
    PHARMACY_WHATSAPP_TEMPLATE_KHATA_REMINDER_EN: 'khata_due_pay_en',
    PHARMACY_WHATSAPP_TEMPLATE_KHATA_REMINDER_EN_PARAMETERS: 'name,balance,dueDate,payTo',
  });
  function consented() {
    store.accounts = [account()];
    store.customers = [customer(true)];
    store.consents = [{ patientId: 'patient-1', granted: true, revokedAt: null }];
  }

  it.each([
    ['08:59 PKT', '2026-10-21T03:59:00Z', 0],
    ['09:00 PKT', '2026-10-21T04:00:00Z', 1],
    ['21:59 PKT', '2026-10-21T16:59:00Z', 1],
    ['22:00 PKT', '2026-10-21T17:00:00Z', 0],
    ['02:00 PKT', '2026-10-20T21:00:00Z', 0],
  ])('enforces the 22:00-09:00 quiet hours at %s', async (_label, at, sends) => {
    consented();
    const provider = new MockWhatsAppProvider(config);
    await processDueWhatsAppKhataReminders({ now: new Date(at), config, provider });
    expect(provider.calls).toHaveLength(sends);
    expect(store.logs).toHaveLength(sends);
  });

  it('sends the amount, local due date and Raast destination, and nothing else', async () => {
    consented();
    store.branch = {
      id: 'branch-1',
      khataReminderEnabled: true,
      manualPaymentSettings: {
        JAZZCASH: { destination: '0300 1111111', allowReferenceSkip: false },
        RAAST: { destination: 'PK36 SCBL 0000 0011 2345 6702', allowReferenceSkip: false },
      },
    };
    const provider = new MockWhatsAppProvider(fullConfig);

    const result = await processDueWhatsAppKhataReminders({
      now: NOW,
      config: fullConfig,
      provider,
    });

    expect(result).toMatchObject({ configured: true, prepared: 1, skippedConfiguration: 0 });
    expect(provider.calls[0]).toMatchObject({
      templateName: 'khata_due_pay_en',
      parameters: [
        'Khan household',
        '500.00',
        '10 Oct 2026',
        'Raast PK36 SCBL 0000 0011 2345 6702',
      ],
    });
    expect(store.logs[0]).toMatchObject({ kind: 'KHATA_REMINDER', dueDate: '2026-10-10' });
  });

  it('falls back to a wallet destination when Raast has none', async () => {
    consented();
    store.branch = {
      id: 'branch-1',
      manualPaymentSettings: {
        RAAST: { destination: '', allowReferenceSkip: false },
        EASYPAISA: { destination: 'Till\n98765', allowReferenceSkip: false },
      },
    };
    const provider = new MockWhatsAppProvider(fullConfig);
    await processDueWhatsAppKhataReminders({ now: NOW, config: fullConfig, provider });
    expect(provider.calls[0]).toMatchObject({
      parameters: ['Khan household', '500.00', '10 Oct 2026', 'Easypaisa Till 98765'],
    });
  });

  it('fails closed when the template needs a pay destination the branch has not entered', async () => {
    consented();
    const provider = new MockWhatsAppProvider(fullConfig);

    const result = await processDueWhatsAppKhataReminders({
      now: NOW,
      config: fullConfig,
      provider,
    });

    expect(result).toMatchObject({ skippedConfiguration: 1, prepared: 0 });
    expect(result.configurationErrors).toContain('KHATA_PARAMETER_PAYTO_UNAVAILABLE');
    expect(provider.calls).toEqual([]);
    expect(store.logs).toEqual([]);
  });

  it('sends nothing from a branch whose owner switched reminders off', async () => {
    consented();
    store.branch = { id: 'branch-1', khataReminderEnabled: false };
    const provider = new MockWhatsAppProvider(config);

    const result = await processDueWhatsAppKhataReminders({ now: NOW, config, provider });

    expect(result).toMatchObject({ prepared: 0, skippedNoConsent: 1 });
    expect(provider.calls).toEqual([]);
    expect(store.logs).toEqual([]);
  });

  it('uses the branch owner cadence and floor carried by the scan', async () => {
    consented();
    store.accounts = [{ ...account(), cadenceDays: 3, minBalanceMinor: 60_000 }];
    const provider = new MockWhatsAppProvider(config);

    const result = await processDueWhatsAppKhataReminders({ now: NOW, config, provider });

    // 500.00 owed is under this branch's 600.00 floor.
    expect(result).toMatchObject({ scanned: 1, notDue: 1, prepared: 0 });
    store.accounts = [{ ...account(), cadenceDays: 3, minBalanceMinor: 10_000 }];
    await processDueWhatsAppKhataReminders({ now: NOW, config, provider });
    expect(store.logs[0].dedupeKey).toMatch(/^khata:family-1:c3:\d+$/);
  });

  it('applies the owner schedule and the recent-reminder cadence in the scan, before the limit', async () => {
    await processDueWhatsAppKhataReminders({
      now: NOW,
      config,
      provider: new MockWhatsAppProvider(config),
    });
    const sql = store.scanSql[0] ?? '';
    expect(sql).toContain('br."khataReminderEnabled" = true');
    expect(sql).toContain('GREATEST(1, br."khataReminderMinBalanceMinor")');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('make_interval(days => br."khataReminderCadenceDays")');
  });
});

describe('planKhataReminder cadence', () => {
  const candidate = {
    familyAccountId: 'family-1',
    balanceMinor: 50_000,
    oldestOverdueAt: new Date('2026-10-10T00:00:00Z'),
  };
  it('keeps the weekly key shape and buckets other cadences by their own period', () => {
    expect(planKhataReminder(candidate, NOW, 10_000, 7).dedupeKey).toBe(
      planKhataReminder(candidate, NOW).dedupeKey
    );
    const daily = planKhataReminder(candidate, NOW, 10_000, 1).dedupeKey;
    const nextDay = planKhataReminder(candidate, new Date(NOW.getTime() + 86_400_000), 10_000, 1);
    expect(daily).toMatch(/^khata:family-1:c1:\d+$/);
    expect(nextDay.dedupeKey).not.toBe(daily);
    expect(planKhataReminder(candidate, NOW, 10_000, 99).dedupeKey).toMatch(/:w\d+$/);
  });
  it('formats the due date in the workspace calendar', () => {
    expect(formatKhataDueDate(new Date('2026-10-09T20:00:00Z'), 'Asia/Karachi')).toBe(
      '10 Oct 2026'
    );
    expect(formatKhataDueDate(new Date('2026-10-09T20:00:00Z'), 'UTC')).toBe('9 Oct 2026');
  });
});

describe('DEV-730 owner reminder for one account', () => {
  it('refuses another organization without scanning, claiming or sending', async () => {
    store.accounts = [account()];
    store.customers = [customer(true)];
    store.consents = [{ patientId: 'patient-1', granted: true, revokedAt: null }];
    const provider = new MockWhatsAppProvider(config);

    const result = await processDueWhatsAppKhataReminders({
      now: NOW,
      config,
      provider,
      account: { organizationId: 'org_b', branchId: 'branch-1', familyAccountId: 'family-1' },
    });

    expect(result).toMatchObject({ configured: false, scanned: 0, prepared: 0 });
    expect(result.configurationErrors).toContain('ORGANIZATION_NOT_CONFIGURED');
    expect(provider.calls).toEqual([]);
    expect(store.logs).toEqual([]);
  });

  it('applies the same consent-gated, once-a-week send to the selected account', async () => {
    store.accounts = [account()];
    store.customers = [customer(true)];
    store.consents = [{ patientId: 'patient-1', granted: true, revokedAt: null }];
    const provider = new MockWhatsAppProvider(config);
    const only = { organizationId: 'org_a', branchId: 'branch-1', familyAccountId: 'family-1' };

    const first = await processDueWhatsAppKhataReminders({
      now: NOW,
      config,
      provider,
      account: only,
    });
    const again = await processDueWhatsAppKhataReminders({
      now: NOW,
      config,
      provider,
      account: only,
    });

    expect(first).toMatchObject({ scanned: 1, prepared: 1 });
    expect(again).toMatchObject({ scanned: 1, duplicate: 1 });
    expect(provider.calls).toHaveLength(1);
  });

  it('narrows the due-account scan to the branch and account', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    await readDueKhataAccounts({ $queryRaw: queryRaw } as never, 'org_a', NOW, 1, 10_000, {
      branchId: 'branch-1',
      familyAccountId: 'family-1',
    });
    const query = queryRaw.mock.calls[0]![0] as { sql: string; values: unknown[] };
    expect(query.sql).toContain('acct."branchId" = ?');
    expect(query.sql).toContain('acct."id" = ?');
    expect(query.values).toEqual(expect.arrayContaining(['branch-1', 'family-1']));

    queryRaw.mockClear();
    await readDueKhataAccounts({ $queryRaw: queryRaw } as never, 'org_a', NOW, 1);
    expect((queryRaw.mock.calls[0]![0] as { sql: string }).sql).not.toContain('acct."id" = ?');
  });
});

describe('DEV-76 schedule switch and the DEV-730 owner send', () => {
  it('still lets an owner send one account a reminder when scheduled reminders are off', async () => {
    store.accounts = [account()];
    store.customers = [customer(true)];
    store.consents = [{ patientId: 'patient-1', granted: true, revokedAt: null }];
    store.branch = { id: 'branch-1', khataReminderEnabled: false };
    const provider = new MockWhatsAppProvider(config);

    const scheduled = await processDueWhatsAppKhataReminders({ now: NOW, config, provider });
    expect(scheduled).toMatchObject({ prepared: 0 });
    const owner = await processDueWhatsAppKhataReminders({
      now: NOW,
      config,
      provider,
      account: { organizationId: 'org_a', branchId: 'branch-1', familyAccountId: 'family-1' },
    });

    expect(owner).toMatchObject({ scanned: 1, prepared: 1 });
    expect(provider.calls).toHaveLength(1);
  });

  it('drops only the on/off switch from a one-account scan; cadence still applies', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    await readDueKhataAccounts({ $queryRaw: queryRaw } as never, 'org_a', NOW, 1);
    expect((queryRaw.mock.calls[0]![0] as { sql: string }).sql).toContain(
      'br."khataReminderEnabled" = true'
    );
    queryRaw.mockClear();
    await readDueKhataAccounts({ $queryRaw: queryRaw } as never, 'org_a', NOW, 1, undefined, {
      branchId: 'branch-1',
      familyAccountId: 'family-1',
    });
    const sql = (queryRaw.mock.calls[0]![0] as { sql: string }).sql;
    expect(sql).not.toContain('br."khataReminderEnabled" = true');
    expect(sql).toContain('make_interval(days => br."khataReminderCadenceDays")');
    expect(sql).toContain('GREATEST(1, br."khataReminderMinBalanceMinor")');
  });

  it('nets dishonoured cheques out of settled charges and treats an unlinked bounce as overdue', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    await readDueKhataAccounts({ $queryRaw: queryRaw } as never, 'org_a', NOW, 1);
    const sql = (queryRaw.mock.calls[0]![0] as { sql: string }).sql;
    expect(sql).toContain("'DISHONOURED_CHEQUE'");
    expect(sql).toContain('CASE WHEN "kind" = \'PAYMENT\' THEN amount ELSE -amount END');
    expect(sql).toContain('unlinked."id" IS NOT NULL');
  });
});
