import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readPharmacyOwnerCommandCentre: vi.fn(),
  readPharmacyAnomalySignals: vi.fn(),
  readOwnerBriefingDemand: vi.fn(),
  refreshPharmacyAnomalySignals: vi.fn(),
  can: vi.fn(),
  resolveOrganizationEntitlements: vi.fn(),
  platformDb: { pharmacyOwnerDigestSetting: { findMany: vi.fn() } },
  tenantDb: {
    pharmacyOwnerDigestSetting: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  },
}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', async () => ({
  ...(await vi.importActual<typeof import('@/lib/entitlements')>('@/lib/entitlements')),
  resolveOrganizationEntitlements: mocks.resolveOrganizationEntitlements,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (callback) => callback(mocks.platformDb)),
  withTenantDb: vi.fn(async (_organizationId, callback) => callback(mocks.tenantDb)),
}));
vi.mock('./reports', () => ({
  readPharmacyOwnerCommandCentre: mocks.readPharmacyOwnerCommandCentre,
  PHARMACY_METRIC_CONTRACT: [
    'salesMinor',
    'marginMinor',
    'cashMinor',
    'refundsMinor',
    'openStockSignals',
    'expiryValueMinor30',
    'expiryValueMinor60',
    'expiryValueMinor90',
    'expiryValueMinor180',
    'openRecalls',
    'quarantineUnits',
    'safetyQueue',
    'deviceFiscalOfflineExceptions',
  ].map((key) => ({ key, label: key, definition: `${key} definition`, source: `${key} source` })),
}));
vi.mock('./anomaly-signals-operations', () => ({
  readPharmacyAnomalySignals: mocks.readPharmacyAnomalySignals,
  refreshPharmacyAnomalySignals: mocks.refreshPharmacyAnomalySignals,
  renderAnomalyDigest: (signals: Array<{ explanation: string }>) => [
    `Anomaly review signals: ${signals.length}`,
    ...signals.map((signal) => `- ${signal.explanation}`),
  ],
}));

vi.mock('./owner-briefing', async () => ({
  ...(await vi.importActual<typeof import('./owner-briefing')>('./owner-briefing')),
  readOwnerBriefingDemand: mocks.readOwnerBriefingDemand,
}));

import {
  CaptureChannel,
  composeOwnerDigest,
  nextDigestDueAt,
  processDueOwnerDigests,
  WhatsAppChannel,
} from './owner-digest';

describe('RPT-03 owner digest', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.resolveOrganizationEntitlements.mockResolvedValue({
      enabledModules: ['pharmacy-reports'],
    });
    mocks.tenantDb.pharmacyOwnerDigestSetting.updateMany.mockResolvedValue({ count: 1 });
    mocks.platformDb.pharmacyOwnerDigestSetting.findMany.mockResolvedValue([]);
    mocks.readPharmacyAnomalySignals.mockResolvedValue([]);
    mocks.readOwnerBriefingDemand.mockResolvedValue({
      lostDemandMinor: 0,
      walkOuts: 0,
      unvaluedWalkOuts: 0,
      recoveredMinor: 0,
      recoveredCount: 0,
      topGap: null,
    });
    mocks.refreshPharmacyAnomalySignals.mockResolvedValue({ evaluated: 0, signals: [] });
    mocks.readPharmacyOwnerCommandCentre.mockResolvedValue({
      freshness: { status: 'CURRENT', asOf: '2026-09-04T08:00:00.000Z', source: 'ledgers' },
      metrics: {
        salesMinor: 10000,
        marginMinor: 2500,
        cashMinor: 6000,
        refundsMinor: 500,
        openStockSignals: 3,
        expiryValueMinor30: 700,
        expiryValueMinor60: 900,
        expiryValueMinor90: 1100,
        expiryValueMinor180: 1300,
        openRecalls: 1,
        quarantineUnits: 2,
        safetyQueue: 4,
        deviceFiscalOfflineExceptions: null,
      },
    });
  });

  it('composes one branch-day by calling the RPT-01 reader and retaining its contracts', async () => {
    const digest = await composeOwnerDigest({} as never, {
      organizationId: 'org_1',
      userId: 'user_1',
      branchId: 'branch_1',
      branchName: 'Main',
      businessDate: '2026-09-04',
    });

    expect(mocks.readPharmacyOwnerCommandCentre).toHaveBeenCalledWith(expect.anything(), {
      branchIds: ['branch_1'],
      from: '2026-09-04',
      to: '2026-09-04',
    });
    expect(digest.metrics.map(({ key }) => key)).toEqual([
      'salesMinor',
      'marginMinor',
      'cashMinor',
      'refundsMinor',
      'openStockSignals',
      'expiryValueMinor30',
      'expiryValueMinor60',
      'expiryValueMinor90',
      'expiryValueMinor180',
      'openRecalls',
      'quarantineUnits',
      'safetyQueue',
      'deviceFiscalOfflineExceptions',
    ]);
    expect(digest.rendered).toContain('cashMinor: PKR 60.00');
    expect(digest.rendered).not.toContain('cashVarianceMinor');
    expect(digest.rendered).toContain('deviceFiscalOfflineExceptions: Not available');
    expect(digest.rendered).toContain('Anomaly review signals: 0');
  });

  it('includes explainable anomaly events in the existing owner digest', async () => {
    mocks.readPharmacyAnomalySignals.mockResolvedValue([
      {
        kind: 'CASH_VARIANCE',
        status: 'OPEN',
        severity: 'REVIEW',
        explanation: 'Counted PKR 1,000 below the expected cash; review the close evidence.',
      },
    ]);
    const digest = await composeOwnerDigest({} as never, {
      organizationId: 'org_1',
      userId: 'user_1',
      branchId: 'branch_1',
      branchName: 'Main',
      businessDate: '2026-09-04',
    });
    expect(digest.rendered).toContain('Anomaly review signals: 1');
    expect(digest.rendered).toContain('review the close evidence');
  });

  it('persists capture delivery with the daily idempotency key', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUniqueOrThrow = vi.fn().mockResolvedValue({ id: 'capture_1' });
    const digest = await composeOwnerDigest({} as never, {
      organizationId: 'org_1',
      userId: 'user_1',
      branchId: 'branch_1',
      branchName: 'Main',
      businessDate: '2026-09-04',
    });

    await expect(
      new CaptureChannel().deliver(
        { pharmacyOwnerDigestCapture: { createMany, findUniqueOrThrow } } as never,
        digest
      )
    ).resolves.toEqual({ delivered: true, reference: 'capture_1' });
    expect(createMany).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org_1',
        userId: 'user_1',
        branchId: 'branch_1',
        businessDate: '2026-09-04',
      }),
      skipDuplicates: true,
    });
    expect(findUniqueOrThrow).toHaveBeenCalledWith({
      where: {
        organizationId_userId_branchId_businessDate: {
          organizationId: 'org_1',
          userId: 'user_1',
          branchId: 'branch_1',
          businessDate: '2026-09-04',
        },
      },
      select: { id: true },
    });
  });

  it('schedules a digest in UTC for a stored zone Intl refuses, instead of throwing', () => {
    const now = new Date('2026-09-04T06:30:00.000Z');
    expect(nextDigestDueAt(now, 'PKT', 480)).toEqual(nextDigestDueAt(now, 'UTC', 480));
    expect(nextDigestDueAt(now, 'PKT', 480)).toEqual(new Date('2026-09-04T08:00:00.000Z'));
  });

  it('adds the five-line briefing to the app digest and a name-free WhatsApp body', async () => {
    mocks.readOwnerBriefingDemand.mockResolvedValue({
      lostDemandMinor: 450000,
      walkOuts: 6,
      unvaluedWalkOuts: 1,
      recoveredMinor: 120000,
      recoveredCount: 2,
      topGap: {
        displayName: 'Zyrtec 10',
        names: ['Zyrtec 10', 'Cetirizine'],
        lostMinor: 300000,
        walkOuts: 4,
        purchaseStatus: 'PO_DRAFT',
      },
    });
    // 2026-09-04 is a Friday: daily only.
    const digest = await composeOwnerDigest({} as never, {
      organizationId: 'org_1',
      userId: 'user_1',
      branchId: 'branch_1',
      branchName: 'Main',
      businessDate: '2026-09-04',
    });
    expect(digest.briefings.map((briefing) => briefing.window.cadence)).toEqual(['DAILY']);
    expect(digest.rendered).toContain('Daily briefing 2026-09-04');
    expect(digest.rendered).toContain('Sales PKR 100 · Cash PKR 60');
    expect(digest.rendered).toContain('Lost demand PKR 4,500 (estimate) · 6 walk-outs');
    expect(digest.rendered).toContain(
      'Top gap: Zyrtec 10 · PKR 3,000 lost, 4 walk-outs · draft PO'
    );
    expect(digest.rendered).toContain('Recovered PKR 1,200 from 2 follow-ups');
    expect(digest.rendered).toContain('Expiry at risk (30 days) PKR 7');
    expect(digest.whatsappBody.split('\n')).toHaveLength(6);
    expect(digest.whatsappBody).toContain('Top gap: PKR 3,000 lost, 4 walk-outs · draft PO');
    expect(digest.whatsappBody).not.toMatch(/zyrtec|cetirizine/i);
    expect(mocks.readOwnerBriefingDemand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: 'org_1', branchId: 'branch_1' }),
      expect.objectContaining({ cadence: 'DAILY', from: '2026-09-04', to: '2026-09-04' }),
      expect.anything()
    );
  });

  it('adds a seven-day weekly summary on the configured weekday', async () => {
    // 2026-09-07 is a Monday, the default weekly weekday.
    const digest = await composeOwnerDigest({} as never, {
      organizationId: 'org_1',
      userId: 'user_1',
      branchId: 'branch_1',
      branchName: 'Main',
      businessDate: '2026-09-07',
    });
    expect(digest.briefings.map((briefing) => briefing.window.cadence)).toEqual([
      'DAILY',
      'WEEKLY',
    ]);
    expect(mocks.readPharmacyOwnerCommandCentre).toHaveBeenCalledWith(expect.anything(), {
      branchIds: ['branch_1'],
      from: '2026-09-01',
      to: '2026-09-07',
    });
    expect(mocks.readOwnerBriefingDemand).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ cadence: 'WEEKLY', days: 7, from: '2026-09-01', to: '2026-09-07' }),
      expect.anything()
    );
    expect(digest.rendered).toContain('Weekly summary 2026-09-01 to 2026-09-07');
    expect(digest.whatsappBody).toContain('Weekly summary 2026-09-01 to 2026-09-07');
  });

  it('never reports a WhatsApp send from the stub', async () => {
    await expect(new WhatsAppChannel().deliver()).resolves.toEqual({ delivered: false });
  });

  async function expectDeniedDigestDisabled() {
    const now = new Date('2026-09-04T08:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    mocks.platformDb.pharmacyOwnerDigestSetting.findMany.mockResolvedValue([
      {
        id: 'setting_1',
        organizationId: 'org_1',
        userId: 'user_1',
        branchId: 'branch_1',
        timeMinutes: 480,
        organization: { timezone: 'UTC' },
      },
    ]);
    mocks.tenantDb.pharmacyOwnerDigestSetting.findFirst.mockResolvedValue({
      id: 'setting_1',
      organizationId: 'org_1',
      userId: 'user_1',
      branchId: 'branch_1',
      enabled: true,
      nextDueAt: now,
      updatedAt: now,
      timeMinutes: 480,
      organization: { status: 'ACTIVE', vertical: 'PHARMACY', timezone: 'UTC' },
      branch: { name: 'Main', active: true, organizationId: 'org_1' },
      user: {
        id: 'user_1',
        organizationId: 'org_1',
        role: 'ADMIN',
        status: 'ACTIVE',
        department: 'Management',
      },
    });
    await expect(processDueOwnerDigests(now)).resolves.toEqual({ due: 1, captured: 0 });
    expect(mocks.readPharmacyOwnerCommandCentre).not.toHaveBeenCalled();
    expect(mocks.tenantDb.pharmacyOwnerDigestSetting.update).toHaveBeenCalledWith({
      where: { id: 'setting_1' },
      data: { enabled: false, nextDueAt: null },
    });
    return now;
  }

  it('disables a due digest before composition when operational access was revoked', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action !== 'reports:operational');
    const now = await expectDeniedDigestDisabled();
    expect(mocks.can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user_1', role: 'ADMIN', status: 'ACTIVE' }),
      'reports:operational',
      undefined,
      expect.objectContaining({ db: mocks.tenantDb, source: 'SYSTEM', now })
    );
  });

  it('disables a due digest before composition when financial access was revoked', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action !== 'reports:financial');
    const now = await expectDeniedDigestDisabled();
    expect(mocks.can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user_1', role: 'ADMIN', status: 'ACTIVE' }),
      'reports:financial',
      undefined,
      expect.objectContaining({ db: mocks.tenantDb, source: 'SYSTEM', now })
    );
  });
});
