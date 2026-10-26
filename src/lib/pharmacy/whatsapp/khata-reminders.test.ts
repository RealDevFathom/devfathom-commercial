import { beforeEach, describe, expect, it, vi } from 'vitest';

type LogRow = { id: string; organizationId: string; dedupeKey: string; [key: string]: unknown };

const store = vi.hoisted(() => ({
  accounts: [] as Array<Record<string, unknown>>,
  customers: [] as Array<Record<string, unknown>>,
  consents: [] as Array<Record<string, unknown>>,
  logs: [] as LogRow[],
  /** The workspace zone the organization row holds. */
  timezone: 'Asia/Karachi',
}));

vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: async () => ({}),
}));
vi.mock('../consent-writer', () => ({
  // The real writer takes a FOR UPDATE row lock on the patient; the fake is a no-op.
  lockPatientConsent: async () => undefined,
}));
vi.mock('@/lib/tenancy/scoped-db', () => {
  const db = {
    // The scan query returns candidate accounts; any other raw query is a row lock.
    $queryRaw: async (query: { sql: string }) =>
      query.sql.includes('pharmacy_family_accounts') ? store.accounts : [{ id: 'patient-1' }],
    organization: {
      findUnique: async () => ({
        vertical: 'PHARMACY',
        status: 'ACTIVE',
        timezone: store.timezone,
      }),
    },
    pharmacyBranch: { findFirst: async () => ({ id: 'branch-1' }) },
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
  planKhataReminder,
  processDueWhatsAppKhataReminders,
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
  store.timezone = 'Asia/Karachi';
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
    // NOW is 08:00 UTC, inside the 08:00-22:00 window in UTC.
    store.timezone = 'PKT';
    store.accounts = [account()];
    store.customers = [customer(true)];
    store.consents = [{ patientId: 'patient-1', granted: true, revokedAt: null }];
    const provider = new MockWhatsAppProvider(config);

    await expect(
      processDueWhatsAppKhataReminders({ now: NOW, config, provider })
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

    const result = await processDueWhatsAppKhataReminders({ now: NOW, config: urduConfig, provider });

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

    const result = await processDueWhatsAppKhataReminders({ now: NOW, config: urduConfig, provider });

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

    const first = await processDueWhatsAppKhataReminders({ now: NOW, config: metaConfig, provider });
    const retry = await processDueWhatsAppKhataReminders({ now: NOW, config: metaConfig, provider });

    expect(first).toMatchObject({ configured: true, sent: 1 });
    expect(retry).toMatchObject({ duplicate: 1, sent: 0 });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
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
    expect(result).toMatchObject({ skippedNoConsent: 1, prepared: 0 });
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
