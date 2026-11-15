import { beforeEach, describe, expect, it, vi } from 'vitest';

type LogRow = { id: string; organizationId: string; dedupeKey: string; [key: string]: unknown };

const store = vi.hoisted(() => ({
  branchName: 'Gulberg',
  notices: [] as Array<Record<string, unknown>>,
  customer: null as Record<string, unknown> | null,
  consent: null as Record<string, unknown> | null,
  logs: [] as Array<{
    id: string;
    organizationId: string;
    dedupeKey: string;
    [key: string]: unknown;
  }>,
  linkCalls: [] as string[],
}));

vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: async () => ({}),
}));
vi.mock('../consent-writer', () => ({
  lockPatientConsent: async () => undefined,
  lockCustomerConsent: async () => undefined,
}));
vi.mock('../sales', () => ({
  linkRestockRecoveries: async (_db: unknown, scope: { branchId: string }) => {
    store.linkCalls.push(scope.branchId);
    return [{ interestId: 'linked' }];
  },
}));
vi.mock('@/lib/tenancy/scoped-db', () => {
  const db = {
    // The real query also excludes notices that already have a log row; the
    // fake returns every notice so the dedupe-key claim is what is exercised.
    $queryRaw: async (query: { sql: string }) =>
      query.sql.includes('pharmacy_restock_notifications')
        ? store.notices.map((notice) => ({ id: notice.id }))
        : [],
    organization: {
      findUnique: async () => ({
        vertical: 'PHARMACY',
        status: 'ACTIVE',
        timezone: 'Asia/Karachi',
      }),
    },
    pharmacyBranch: { findMany: async () => [{ id: 'branch-1', name: store.branchName }] },
    pharmacyRestockNotification: { findMany: async () => store.notices },
    pharmacyCustomer: { findFirst: async () => store.customer },
    patientConsent: { findFirst: async () => store.consent },
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
    withPlatformDb: (run: (tx: unknown) => unknown) => run(db),
    withTenantDb: (_organizationId: string, run: (tx: unknown) => unknown) => run(db),
  };
});

import { backInStockReference, BACK_IN_STOCK_CATEGORY_TERMS } from '../back-in-stock';
import { processBackInStockNotices } from './back-in-stock';
import { MockWhatsAppProvider, readWhatsAppConfig } from './provider';

// 15:00 in Karachi: outside quiet hours.
const NOW = new Date('2026-11-15T10:00:00.000Z');
const DAY = 86_400_000;
const config = readWhatsAppConfig({
  PHARMACY_WHATSAPP_TEMPLATE_BACK_IN_STOCK: 'back_in_stock_v1',
  PHARMACY_WHATSAPP_ORGANIZATION_ID: 'org-1',
  PHARMACY_WHATSAPP_PHONE_NUMBER_ID: 'phone-1',
});
const policy = { requestExpiryDays: 14, recoveryWindowDays: 7 };

function notice(id: string, createdDaysAgo: number) {
  return {
    id,
    interest: {
      id: `interest-${id}`,
      status: 'NOTIFIED',
      patientId: 'patient-1',
      createdAt: new Date(NOW.getTime() - createdDaysAgo * DAY),
      demandEvent: {
        requestedText: 'panadol extra',
        medicine: {
          productName: 'Panadol Extra',
          brandName: 'Panadol',
          strengths: [
            { ingredient: { name: 'Paracetamol' } },
            { ingredient: { name: 'Caffeine' } },
          ],
        },
      },
    },
  };
}

beforeEach(() => {
  store.branchName = 'Gulberg';
  store.notices = [notice('n1', 3)];
  store.customer = {
    id: 'customer-1',
    active: true,
    whatsappOptIn: true,
    patient: { phone: '0300 1234567' },
  };
  store.consent = { granted: true, revokedAt: null, recordedAt: new Date('2026-01-01') };
  store.logs = [];
  store.linkCalls = [];
});

describe('DEV-79 back-in-stock WhatsApp notices', () => {
  it('sends the utility template with branch, date and reference only', async () => {
    const provider = new MockWhatsAppProvider(config);
    const result = await processBackInStockNotices({ now: NOW, config, provider, policy });
    expect(result).toMatchObject({ configured: true, scanned: 1, prepared: 1, linked: 1 });
    expect(provider.calls).toEqual([
      expect.objectContaining({
        kind: 'template',
        to: '923001234567',
        template: 'backInStock',
        templateName: 'back_in_stock_v1',
        parameters: ['Gulberg', '2026-11-12', backInStockReference('interest-n1')],
      }),
    ]);
    const sent = provider.calls[0]!;
    const text = (sent.kind === 'template' ? sent.parameters : []).join(' ').toLowerCase();
    for (const term of ['panadol', 'paracetamol', 'caffeine', ...BACK_IN_STOCK_CATEGORY_TERMS])
      expect(text).not.toContain(term);
    expect(store.logs).toEqual([
      expect.objectContaining({ kind: 'BACK_IN_STOCK', dedupeKey: 'back-in-stock:n1' }),
    ]);
  });

  it('sends each notice once across repeated runs, oldest first', async () => {
    store.notices = [notice('n1', 3), notice('n2', 1)];
    const provider = new MockWhatsAppProvider(config);
    await processBackInStockNotices({ now: NOW, config, provider, policy });
    const again = await processBackInStockNotices({ now: NOW, config, provider, policy });
    expect(provider.calls).toHaveLength(2);
    expect(store.logs.map((log) => log.dedupeKey)).toEqual([
      'back-in-stock:n1',
      'back-in-stock:n2',
    ]);
    expect(again.duplicate).toBe(2);
  });

  it('never sends a notice for a request older than 14 days', async () => {
    store.notices = [notice('stale', 15)];
    const provider = new MockWhatsAppProvider(config);
    const result = await processBackInStockNotices({ now: NOW, config, provider, policy });
    expect(result.expired).toBe(1);
    expect(provider.calls).toEqual([]);
  });

  it('withholds the notice when the branch name would name the product or its salt', async () => {
    for (const branchName of ['Panadol Corner', 'Paracetamol Point', 'Vitamin House']) {
      store.branchName = branchName;
      store.logs = [];
      const provider = new MockWhatsAppProvider(config);
      const result = await processBackInStockNotices({ now: NOW, config, provider, policy });
      expect(result.skippedUnsafeText).toBe(1);
      expect(provider.calls).toEqual([]);
      expect(store.logs).toEqual([]);
    }
  });

  it('only messages customers who opted in with a current consent', async () => {
    store.consent = {
      granted: true,
      revokedAt: new Date('2026-11-01'),
      recordedAt: new Date('2026-01-01'),
    };
    const provider = new MockWhatsAppProvider(config);
    const revoked = await processBackInStockNotices({ now: NOW, config, provider, policy });
    store.consent = { granted: true, revokedAt: null, recordedAt: new Date('2026-01-01') };
    store.customer = { ...store.customer!, whatsappOptIn: null };
    const neverAsked = await processBackInStockNotices({ now: NOW, config, provider, policy });
    expect(revoked.skippedNoConsent).toBe(1);
    expect(neverAsked.skippedNoConsent).toBe(1);
    expect(provider.calls).toEqual([]);
  });

  it('holds notices during quiet hours but still links recoveries', async () => {
    const provider = new MockWhatsAppProvider(config);
    const result = await processBackInStockNotices({
      now: new Date('2026-11-15T18:30:00.000Z'), // 23:30 in Karachi
      config,
      provider,
      policy,
    });
    expect(result).toMatchObject({ quietHours: true, scanned: 0, linked: 1 });
    expect(provider.calls).toEqual([]);
    expect(store.linkCalls).toEqual(['branch-1']);
  });

  it('does nothing without a bound organization', async () => {
    const provider = new MockWhatsAppProvider(config);
    const result = await processBackInStockNotices({
      now: NOW,
      config: { ...config, organizationId: null },
      provider,
      policy,
    });
    expect(result).toMatchObject({ configured: false, scanned: 0, linked: 0 });
  });
});
