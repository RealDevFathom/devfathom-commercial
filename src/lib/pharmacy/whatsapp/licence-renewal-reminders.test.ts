import { beforeEach, describe, expect, it, vi } from 'vitest';

type Log = { id: string; dedupeKey: string; status: string; [key: string]: unknown };

const state = vi.hoisted(() => ({
  logs: [] as Log[],
  settings: [] as unknown[],
  organization: { vertical: 'PHARMACY', status: 'ACTIVE', timezone: 'Asia/Karachi' } as unknown,
  reminders: [] as unknown[],
  can: vi.fn(async () => true),
  enabledModules: ['pharmacy-reports'] as string[],
  readReminders: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: state.can,
}));
vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: state.enabledModules })),
  hasModule: (entitlements: { enabledModules: string[] }, module: string) =>
    entitlements.enabledModules.includes(module),
}));
vi.mock('../licence-renewal-operations', () => ({
  readLicenceRenewalReminders: state.readReminders,
}));
vi.mock('@/lib/tenancy/scoped-db', () => {
  const db = {
    organization: { findUnique: async () => state.organization },
    pharmacyOwnerDigestSetting: { findMany: async () => state.settings },
    pharmacyMessageLog: {
      createManyAndReturn: async ({ data }: { data: Array<Omit<Log, 'id'>> }) => {
        const entry = data[0]!;
        if (state.logs.some((log) => log.dedupeKey === entry.dedupeKey)) return [];
        const log = { ...entry, id: `log_${state.logs.length + 1}` } as Log;
        state.logs.push(log);
        return [{ id: log.id }];
      },
      update: async ({ where, data }: { where: { id: string }; data: object }) => {
        const log = state.logs.find((row) => row.id === where.id)!;
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

import { planRenewalReminders } from '../licence-renewal';
import { MockWhatsAppProvider, readWhatsAppConfig } from './provider';
import {
  processDueWhatsAppLicenceRenewalReminders,
  renewalMessageDedupeKey,
  renewalRemindersToMessage,
} from './licence-renewal-reminders';

// 08:00 UTC is 13:00 in Asia/Karachi: inside business hours.
const NOW = new Date('2026-09-04T08:00:00.000Z');
const DAY_MS = 86_400_000;
const config = readWhatsAppConfig({
  PHARMACY_WHATSAPP_TEMPLATE_LICENCE_RENEWAL: 'licence_renewal_v1',
  PHARMACY_WHATSAPP_ORGANIZATION_ID: 'org_a',
  PHARMACY_WHATSAPP_PHONE_NUMBER_ID: 'sandbox-owner',
});

function owner(id = 'owner_1', phone: string | null = '03001234567') {
  return {
    branchId: 'branch_1',
    user: {
      id,
      organizationId: 'org_a',
      status: 'ACTIVE',
      role: 'ADMIN',
      department: 'Management',
      phone,
    },
  };
}

function due(daysLeft = 30) {
  return planRenewalReminders(
    [
      {
        kind: 'BRANCH_LICENCE',
        subjectId: 'branch_1',
        branchId: 'branch_1',
        label: 'Main drug sale licence',
        reference: 'DSL-1',
        expiresAt: new Date(NOW.getTime() + daysLeft * DAY_MS),
        provinceCode: 'PK-PB',
        licenceCategory: 'PHARMACY',
      },
    ],
    NOW
  );
}

beforeEach(() => {
  state.logs.length = 0;
  state.settings = [owner()];
  state.organization = { vertical: 'PHARMACY', status: 'ACTIVE', timezone: 'Asia/Karachi' };
  state.enabledModules = ['pharmacy-reports'];
  state.can.mockReset().mockResolvedValue(true);
  state.readReminders.mockReset().mockImplementation(async () => due());
});

describe('#720 owner WhatsApp licence renewal reminders', () => {
  it('stays off until the renewal template is configured', async () => {
    const provider = new MockWhatsAppProvider(readWhatsAppConfig({}));
    const result = await processDueWhatsAppLicenceRenewalReminders({
      now: NOW,
      config: readWhatsAppConfig({}),
      provider,
    });
    expect(result.configured).toBe(false);
    expect(provider.calls).toEqual([]);
    expect(state.readReminders).not.toHaveBeenCalled();
  });

  it('sends the utility template to the owner only, once per licence stage', async () => {
    const provider = new MockWhatsAppProvider(config);
    const first = await processDueWhatsAppLicenceRenewalReminders({ now: NOW, config, provider });
    expect(first).toMatchObject({ configured: true, owners: 1, scanned: 1, prepared: 1 });
    expect(provider.calls).toEqual([
      {
        kind: 'template',
        to: '923001234567',
        template: 'licenceRenewalReminder',
        templateName: 'licence_renewal_v1',
        parameters: ['Main drug sale licence', 'DSL-1', '2026-10-04', '30', 'Rs 3,000 (pharmacy)'],
      },
    ]);
    expect(state.logs).toEqual([
      expect.objectContaining({
        kind: 'LICENCE_RENEWAL_REMINDER',
        branchId: 'branch_1',
        phoneLast4: '4567',
        dueDate: '2026-10-04',
        dedupeKey: 'renewal:BRANCH_LICENCE:branch_1:2026-10-04:30:owner:owner_1',
      }),
    ]);
    expect(state.logs[0]).not.toHaveProperty('customerId');
    expect(state.logs[0]).not.toHaveProperty('patientId');
    expect(state.readReminders).toHaveBeenCalledWith(expect.anything(), {
      organizationId: 'org_a',
      branchIds: ['branch_1'],
      at: NOW,
    });

    const again = await processDueWhatsAppLicenceRenewalReminders({ now: NOW, config, provider });
    expect(again).toMatchObject({ duplicate: 1, prepared: 0 });
    expect(provider.calls).toHaveLength(1);
  });

  it('sends nothing once the renewed licence is saved', async () => {
    state.readReminders.mockResolvedValue([]);
    const provider = new MockWhatsAppProvider(config);
    const result = await processDueWhatsAppLicenceRenewalReminders({ now: NOW, config, provider });
    expect(result).toMatchObject({ owners: 1, scanned: 0 });
    expect(provider.calls).toEqual([]);
  });

  it('skips an owner without a phone or without reports:operational', async () => {
    state.settings = [owner('owner_1', null), owner('owner_2')];
    state.can.mockImplementation(async () => false);
    const provider = new MockWhatsAppProvider(config);
    const result = await processDueWhatsAppLicenceRenewalReminders({ now: NOW, config, provider });
    expect(result).toMatchObject({ owners: 2, skipped: 2 });
    expect(provider.calls).toEqual([]);
    expect(state.logs).toEqual([]);
  });

  it('sends nothing at night, without Pharmacy Reports, or for a non-pharmacy workspace', async () => {
    const provider = new MockWhatsAppProvider(config);
    // 20:00 UTC is 01:00 in Karachi.
    await processDueWhatsAppLicenceRenewalReminders({
      now: new Date('2026-09-04T20:00:00.000Z'),
      config,
      provider,
    });
    state.enabledModules = [];
    await processDueWhatsAppLicenceRenewalReminders({ now: NOW, config, provider });
    state.enabledModules = ['pharmacy-reports'];
    state.organization = { vertical: 'RESTAURANT', status: 'ACTIVE', timezone: 'Asia/Karachi' };
    await processDueWhatsAppLicenceRenewalReminders({ now: NOW, config, provider });
    expect(provider.calls).toEqual([]);
    expect(state.logs).toEqual([]);
  });
});

describe('#720 renewal message planning', () => {
  it('messages only the 90/60/30/7-day stages, not a lapsed licence', () => {
    expect(renewalRemindersToMessage(due(-1))).toEqual([]);
    expect(renewalRemindersToMessage(due(7)).map((reminder) => reminder.stage)).toEqual([7]);
  });

  it('keys each message by owner, licence, expiry and stage', () => {
    const [reminder] = due(60);
    expect(renewalMessageDedupeKey(reminder!, 'owner_9')).toBe(
      'renewal:BRANCH_LICENCE:branch_1:2026-11-03:60:owner:owner_9'
    );
  });
});
