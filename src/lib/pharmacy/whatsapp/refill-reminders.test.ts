import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applySendAuthorityUpdate } from '../../../../tests/support/whatsapp-message-log-store';

type LogRow = { id: string; organizationId: string; dedupeKey: string; [key: string]: unknown };

const store = vi.hoisted(() => ({
  captures: [] as Array<Record<string, unknown>>,
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
vi.mock('@/lib/tenancy/scoped-db', () => {
  const db = {
    // The real query also excludes captures that already have a log row; the
    // fake returns every capture so the dedupe-key claim is what is exercised.
    $queryRaw: async (query: { sql: string }) =>
      query.sql.includes('FOR UPDATE') ? [{ id: 'patient-1' }] : store.captures,
    organization: {
      findUnique: async () => ({
        vertical: 'PHARMACY',
        status: 'ACTIVE',
        timezone: store.timezone,
      }),
    },
    pharmacyBranch: { findFirst: async () => ({ id: 'branch-1' }) },
    pharmacyCustomer: {
      findFirst: async ({ where }: { where: { patientId: string } }) =>
        store.customers.find((customer) => customer.patientId === where.patientId) ?? null,
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
            (log) => log.organizationId === row.organizationId && log.dedupeKey === row.dedupeKey
          )
        )
          return [];
        const created = { ...row, id: `log-${store.logs.length + 1}` } as LogRow;
        store.logs.push(created);
        return [{ id: created.id }];
      },
      updateMany: async (args: Parameters<typeof applySendAuthorityUpdate>[1]) =>
        applySendAuthorityUpdate(store.logs, args),
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
import { planRefillReminder, processDueWhatsAppRefillReminders } from './refill-reminders';

const DISPENSED_AT = new Date('2026-09-01T09:00:00.000Z');
// 30 tablets, once daily: runs out 2026-10-01T09:00Z; 3-day lead opens 2026-09-28T09:00Z.
const NOW = new Date('2026-09-29T08:00:00.000Z');
const config = readWhatsAppConfig({
  PHARMACY_WHATSAPP_TEMPLATE_REFILL_REMINDER: 'refill_due_v1',
  PHARMACY_WHATSAPP_ORGANIZATION_ID: 'org_a',
  PHARMACY_WHATSAPP_PHONE_NUMBER_ID: 'sandbox-owner',
});

function capture(id: string, patientId = 'patient-1', medicineId = 'medicine-1') {
  return {
    id,
    organizationId: 'org_a',
    branchId: 'branch-1',
    patientId,
    medicineId,
    medicineName: 'Panadol 500 mg',
    directionsEnglish: 'one tablet once daily',
    quantityDispensed: 30,
    dispensedAt: DISPENSED_AT,
  };
}

function customer(patientId: string, whatsappOptIn: boolean | null) {
  return {
    id: `customer-${patientId}`,
    patientId,
    active: true,
    displayName: 'Ayesha',
    whatsappOptIn,
    patient: { phone: '0300-1234567' },
  };
}

beforeEach(() => {
  store.captures = [];
  store.customers = [];
  store.consents = [];
  store.logs = [];
  store.timezone = 'Asia/Karachi';
});

describe('planRefillReminder', () => {
  const input = {
    patientId: 'patient-1',
    medicineId: 'medicine-1',
    dispensedAt: DISPENSED_AT,
    quantityDispensed: 30,
    directions: 'one tablet once daily',
  };

  it('keys the reminder by patient x medicine x run-out date from deriveRefillSchedule', () => {
    const plan = planRefillReminder(input, NOW, 3);
    expect(plan).toMatchObject({
      dueDate: '2026-10-01',
      due: true,
      dedupeKey: 'refill:patient-1:medicine-1:2026-10-01',
    });
    expect(plan.sendAt.toISOString()).toBe('2026-09-28T09:00:00.000Z');
  });

  it('is stable across runs and only due inside the lead window', () => {
    const later = planRefillReminder(input, new Date('2026-09-30T12:00:00.000Z'), 3);
    expect(later.dedupeKey).toBe(planRefillReminder(input, NOW, 3).dedupeKey);
    expect(planRefillReminder(input, new Date('2026-09-27T00:00:00.000Z'), 3).due).toBe(false);
    expect(planRefillReminder(input, new Date('2026-10-01T09:00:00.000Z'), 3).due).toBe(false);
    expect(planRefillReminder(input, NOW, 1).due).toBe(false);
  });
});

describe('processDueWhatsAppRefillReminders', () => {
  it('sends once per patient x medicine x due date across repeated runs', async () => {
    // Two fills of the same medicine with the same run-out date collapse to one reminder.
    store.captures = [capture('capture-1'), capture('capture-2')];
    store.customers = [customer('patient-1', true)];
    store.consents = [{ patientId: 'patient-1', granted: true, revokedAt: null }];
    const provider = new MockWhatsAppProvider(config);

    const first = await processDueWhatsAppRefillReminders({ now: NOW, config, provider });
    const second = await processDueWhatsAppRefillReminders({ now: NOW, config, provider });

    expect(first).toMatchObject({
      scanned: 2,
      sent: 0,
      prepared: 1,
      unknown: 0,
      skippedNoConsent: 1,
      failed: 0,
    });
    expect(second).toMatchObject({ scanned: 2, sent: 0, skippedNoConsent: 2 });
    expect(provider.calls).toEqual([
      {
        kind: 'template',
        to: '923001234567',
        template: 'refillReminder',
        templateName: 'refill_due_v1',
        parameters: ['2026-10-01'],
      },
    ]);
    expect(store.logs).toHaveLength(1);
    expect(store.logs[0]).toMatchObject({
      kind: 'REFILL_REMINDER',
      direction: 'OUTBOUND',
      status: 'IGNORED',
      error: 'MOCK_PREPARED',
      dedupeKey: 'refill:patient-1:medicine-1:2026-10-01',
      phoneLast4: '4567',
      dueDate: '2026-10-01',
      providerMessageId: 'mock-wamid-1',
    });
  });

  it.each([
    ['never asked (null opt-in)', null, { granted: true, revokedAt: null }],
    ['opted out via STOP', false, { granted: true, revokedAt: null }],
    ['opted in but REMINDERS consent revoked', true, { granted: true, revokedAt: NOW }],
    ['opted in but REMINDERS consent denied', true, { granted: false, revokedAt: null }],
    ['opted in without a REMINDERS consent record', true, null],
  ])('sends nothing when %s', async (_label, optIn, consent) => {
    store.captures = [capture('capture-1')];
    store.customers = [customer('patient-1', optIn)];
    store.consents = consent ? [{ patientId: 'patient-1', ...consent }] : [];
    const provider = new MockWhatsAppProvider(config);

    const result = await processDueWhatsAppRefillReminders({ now: NOW, config, provider });

    expect(result).toMatchObject({ scanned: 1, sent: 0, skippedNoConsent: 1 });
    expect(provider.calls).toEqual([]);
    expect(store.logs).toEqual([]);
  });

  it('reads the send window in UTC for a stored zone Intl refuses, instead of failing the run', async () => {
    // NOW is 08:00 UTC, inside the 08:00-22:00 window in UTC.
    store.timezone = 'PKT';
    store.captures = [capture('capture-1')];
    store.customers = [customer('patient-1', true)];
    store.consents = [{ patientId: 'patient-1', granted: true, revokedAt: null }];
    const provider = new MockWhatsAppProvider(config);

    await expect(
      processDueWhatsAppRefillReminders({ now: NOW, config, provider })
    ).resolves.toMatchObject({ scanned: 1, prepared: 1, failed: 0 });
    expect(provider.calls).toHaveLength(1);
  });

  it('does nothing until the reminder template name is configured', async () => {
    store.captures = [capture('capture-1')];
    const provider = new MockWhatsAppProvider(readWhatsAppConfig({}));
    const result = await processDueWhatsAppRefillReminders({
      now: NOW,
      config: readWhatsAppConfig({}),
      provider,
    });
    expect(result).toMatchObject({ configured: false, scanned: 0 });
    expect(provider.calls).toEqual([]);
  });
});
