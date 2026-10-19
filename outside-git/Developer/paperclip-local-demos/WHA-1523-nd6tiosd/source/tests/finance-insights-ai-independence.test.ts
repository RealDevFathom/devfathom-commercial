import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boundaries = vi.hoisted(() => ({
  provider: vi.fn(() => {
    throw new Error('AI provider unavailable');
  }),
  network: vi.fn(() => {
    throw new Error('External execution is forbidden in this suite');
  }),
}));

// Isolate infrastructure, never the capability/module gates or report readers.
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: () => {
    throw new Error('Use the explicit non-DB fixture');
  },
  withPlatformDb: () => {
    throw new Error('No platform database in this suite');
  },
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => false,
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
}));
vi.mock('@/lib/ai/provider', () => ({ createAIModel: boundaries.provider }));

import { Prisma } from '@/generated/prisma/client';
import { visibleNavigation } from '@/components/layout/sidebar';
import { useAssistant } from '@/lib/assistant-store';
import { hasModule } from '@/lib/entitlements';
import { moduleForPath, type EntitlementView } from '@/lib/module-catalog';
import type { readPharmacyOwnerCommandCentre } from '@/lib/pharmacy/reports';
import type { readPharmacyAnomalySignals } from '@/lib/pharmacy/anomaly-signals-operations';
import type { readOverviewReport } from '@/lib/restaurant/reports';
import type { readInsightReport } from '@/lib/restaurant/insights';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import { restaurantInsightsRouter } from '@/server/routers/restaurant-insights';
import { restaurantReportsRouter } from '@/server/routers/restaurant-reports';
import { router, type TRPCContext } from '@/server/trpc';

// Preserve production prefixes: a leaf createCaller would bypass moduleForProcedure.
const app = router({
  restaurantReports: restaurantReportsRouter,
  restaurantInsights: restaurantInsightsRouter,
  pharmacyReports: pharmacyReportsRouter,
});
const day = '2026-09-01';
const date = new Date(`${day}T00:00:00.000Z`);
const restaurantModules = ['restaurant-core', 'restaurant-pos', 'restaurant-insights'];

function fixture(
  vertical: 'RESTAURANT' | 'PHARMACY',
  options: {
    organizationId?: string;
    denied?: string[];
    modules?: string[];
    salesMinor?: number;
  } = {}
) {
  const organizationId = options.organizationId ?? 'org-a';
  const branchId = `${organizationId}-branch`;
  const entitlements: EntitlementView = {
    organizationId,
    vertical,
    enabledModules:
      options.modules ??
      (vertical === 'RESTAURANT' ? [...restaurantModules] : ['pharmacy-reports']),
    modules: [],
    limits: {},
    activeSeats: 1,
    seatLimit: 10,
  };
  const row = {
    id: `${organizationId}-rollup`,
    branchId,
    businessDate: date,
    sourceDailyCloseId: `${organizationId}-close`,
    orderCount: 4,
    coverCount: 7,
    grossSales: new Prisma.Decimal('125.50'),
    netSales: new Prisma.Decimal('120.25'),
    deliveryFeeSales: new Prisma.Decimal('2'),
    deliveryFeeRefunds: new Prisma.Decimal('0'),
    compTotal: new Prisma.Decimal('0'),
    refundTotal: new Prisma.Decimal('0'),
    voidTotal: new Prisma.Decimal('0'),
    drawerVariance: new Prisma.Decimal('-0.50'),
    computedAt: date,
    createdAt: date,
    updatedAt: date,
    branch: { name: organizationId, timezone: 'Asia/Karachi' },
    sourceDailyClose: { supersededBy: [] },
  };
  const branches = vi.fn(async ({ where }: { where: { organizationId: string } }) =>
    where.organizationId === organizationId ? [{ id: branchId, name: organizationId }] : []
  );
  const db = {
    user: {
      findUnique: vi.fn(async () => ({
        organizationRole: {
          permissions: [
            { capability: 'reports:operational', effect: 'ALLOW' },
            { capability: 'reports:financial', effect: 'ALLOW' },
            { capability: 'restaurant:configure', effect: 'ALLOW' },
          ],
        },
        permissionOverrides: (options.denied ?? []).map((capability) => ({
          capability,
          effect: 'DENY',
        })),
      })),
    },
    restaurantBranch: { findMany: branches },
    pharmacyBranch: { findMany: branches },
    restaurantStaffProfile: {
      findFirst: vi.fn(async () => ({ primaryBranchId: branchId })),
    },
    restaurantDailyClose: {
      findMany: vi.fn(async () => [
        {
          id: row.sourceDailyCloseId,
          branchId,
          businessDate: date,
          createdAt: date,
          supersedesCloseId: null,
        },
      ]),
    },
    insightDailyRollup: {
      findMany: vi.fn(async () => [row]),
      findFirst: vi.fn(async () => row),
    },
    insightItemMixRollup: { findMany: vi.fn(async () => []) },
    insightLoyaltyLiability: {
      findFirst: vi.fn(async () => ({ liability: new Prisma.Decimal('8.25') })),
    },
    pharmacyAnomalySignal: {
      findMany: vi.fn(async () => [
        { id: `${organizationId}-signal`, branchId, scope: { branchId } },
      ]),
    },
    pharmacyRecallNotice: { count: vi.fn(async () => 0) },
    pharmacySupplierClaim: { count: vi.fn(async () => 0) },
    pharmacyReceivingException: { count: vi.fn(async () => 0) },
    branchRegulatoryProfile: { count: vi.fn(async () => 0) },
    $queryRaw: vi.fn(async (query: Prisma.Sql) =>
      query.sql.includes('AS "salesMinor"')
        ? [
            {
              salesMinor: options.salesMinor ?? 12550,
              marginMinor: 2050,
              cashMinor: 12550,
              refundsMinor: 0,
              cashVarianceMinor: 0,
            },
          ]
        : []
    ),
  };
  const context: TRPCContext = {
    db: db as unknown as ScopedDb,
    entitlements,
    session: {
      expires: '2099-01-01',
      user: {
        id: `${organizationId}-user`,
        role: 'ADMIN',
        status: 'ACTIVE',
        organizationId,
        organizationSlug: organizationId,
        organizationStatus: 'ACTIVE',
        name: 'Synthetic report reader',
        email: 'reader@example.invalid',
        department: '',
        title: '',
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  };
  return {
    db,
    entitlements,
    branchId,
    caller: app.createCaller(context),
    range: { branchId, from: day, to: day },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', boundaries.network);
  useAssistant.getState().setOpen(false);
});

afterEach(() => {
  expect(boundaries.provider).not.toHaveBeenCalled();
  expect(boundaries.network).not.toHaveBeenCalled();
  useAssistant.getState().setOpen(false);
  vi.unstubAllGlobals();
});

describe('deterministic readers with an unavailable AI provider', () => {
  // This checkout has UI open/close state, not a company assistant enable flag.
  // Both states must leave real report authorization and readers independent.
  it.each([false, true])(
    'keeps Restaurant reports/insights usable with assistant open=%s',
    async (open) => {
      useAssistant.getState().setOpen(open);
      const f = fixture('RESTAURANT');
      const overview: Awaited<ReturnType<typeof readOverviewReport>> =
        await f.caller.restaurantReports.overview(f.range);
      const insight: Awaited<ReturnType<typeof readInsightReport>> =
        await f.caller.restaurantInsights.readFinancialReport({
          branchId: f.branchId,
          businessDate: day,
        });
      expect(overview).toMatchObject({
        orderCount: 4,
        coverCount: 7,
        freshness: { status: 'CURRENT' },
      });
      expect(insight).toMatchObject({
        branchId: f.branchId,
        netSales: '120.25',
        loyaltyLiability: '8.25',
      });
      expect(f.db.insightDailyRollup.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { branchId: f.branchId, businessDate: date } })
      );
    }
  );

  it.each([false, true])(
    'keeps Pharmacy reports/insights usable with assistant open=%s',
    async (open) => {
      useAssistant.getState().setOpen(open);
      const f = fixture('PHARMACY');
      const report = await f.caller.pharmacyReports.commandCentre(f.range);
      // The router adds financial redaction; source period/scope stays typed.
      const filters: Awaited<ReturnType<typeof readPharmacyOwnerCommandCentre>>['filters'] =
        report.filters;
      const signals: Awaited<ReturnType<typeof readPharmacyAnomalySignals>> =
        await f.caller.pharmacyReports.anomalySignals(f.range);
      expect(report).toMatchObject({
        filters: { branchIds: [f.branchId] },
        metrics: { salesMinor: 12550, marginMinor: 2050 },
      });
      expect(filters).toMatchObject({ branchIds: [f.branchId], from: day, to: day });
      expect(signals).toEqual([
        { id: 'org-a-signal', branchId: f.branchId, scope: { branchId: f.branchId } },
      ]);
      expect(f.db.pharmacyAnomalySignal.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ branchId: { in: [f.branchId] } }),
        })
      );
    }
  );
});

describe('assistant UI state cannot grant report capability or licensing', () => {
  it('denies Restaurant direct report/insight callers despite an open assistant', async () => {
    useAssistant.getState().setOpen(true);
    const f = fixture('RESTAURANT', { denied: ['reports:operational', 'reports:financial'] });
    await expect(f.caller.restaurantReports.overview(f.range)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      f.caller.restaurantInsights.readFinancialReport({ branchId: f.branchId, businessDate: day })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.restaurantDailyClose.findMany).not.toHaveBeenCalled();
    expect(f.db.insightDailyRollup.findFirst).not.toHaveBeenCalled();
  });

  it('denies Pharmacy report/insight callers despite an open assistant', async () => {
    useAssistant.getState().setOpen(true);
    const f = fixture('PHARMACY', { denied: ['reports:operational'] });
    await expect(f.caller.pharmacyReports.commandCentre(f.range)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(f.caller.pharmacyReports.anomalySignals(f.range)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(f.db.$queryRaw).not.toHaveBeenCalled();
    expect(f.db.pharmacyAnomalySignal.findMany).not.toHaveBeenCalled();
  });

  it('redacts Pharmacy money and denies financial insights without financial capability', async () => {
    useAssistant.getState().setOpen(true);
    const f = fixture('PHARMACY', { denied: ['reports:financial'] });
    const report = await f.caller.pharmacyReports.commandCentre(f.range);
    expect(report.permissions).toEqual({ operational: true, financial: false });
    expect(report.metrics).toMatchObject({
      salesMinor: null,
      marginMinor: null,
      cashMinor: null,
      refundsMinor: null,
      cashVarianceMinor: null,
    });
    await expect(f.caller.pharmacyReports.anomalySignals(f.range)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(f.db.pharmacyAnomalySignal.findMany).not.toHaveBeenCalled();
  });

  it('enforces the real prefixed Restaurant insight entitlement', async () => {
    const f = fixture('RESTAURANT', { modules: ['restaurant-core', 'restaurant-pos'] });
    await expect(f.caller.restaurantReports.overview(f.range)).resolves.toMatchObject({
      orderCount: 4,
    });
    await expect(
      f.caller.restaurantInsights.readFinancialReport({ branchId: f.branchId, businessDate: day })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'The restaurant-insights module is not enabled for this organization.',
    });
    expect(f.db.insightDailyRollup.findFirst).not.toHaveBeenCalled();
  });

  it('enforces Pharmacy licensing before deterministic reads', async () => {
    const f = fixture('PHARMACY', { modules: ['pharmacy-core'] });
    await expect(f.caller.pharmacyReports.commandCentre(f.range)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Pharmacy reports are not licensed.',
    });
    await expect(f.caller.pharmacyReports.anomalySignals(f.range)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(f.db.$queryRaw).not.toHaveBeenCalled();
    expect(f.db.pharmacyAnomalySignal.findMany).not.toHaveBeenCalled();
  });
});

describe('organization/branch boundaries without provider fallback', () => {
  it('rejects a foreign Restaurant branch before reading, including insight branch proof', async () => {
    const f = fixture('RESTAURANT', { denied: ['restaurant:configure'] });
    // The report branch resolver also permits an explicit staff assignment.
    Object.assign(f.db, { restaurantBranchAssignment: { findMany: vi.fn(async () => []) } });
    await expect(
      f.caller.restaurantReports.overview({ ...f.range, branchId: 'org-b-branch' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      f.caller.restaurantInsights.readFinancialReport({
        branchId: 'org-b-branch',
        businessDate: day,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.restaurantBranch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org-a' }) })
    );
    expect(f.db.restaurantDailyClose.findMany).not.toHaveBeenCalled();
    expect(f.db.insightDailyRollup.findFirst).not.toHaveBeenCalled();
  });

  it('rejects a foreign Pharmacy branch before report or insight data access', async () => {
    const f = fixture('PHARMACY');
    const range = { ...f.range, branchId: 'org-b-branch' };
    await expect(f.caller.pharmacyReports.commandCentre(range)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(f.caller.pharmacyReports.anomalySignals(range)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(f.db.pharmacyBranch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-a', active: true } })
    );
    expect(f.db.$queryRaw).not.toHaveBeenCalled();
    expect(f.db.pharmacyAnomalySignal.findMany).not.toHaveBeenCalled();
  });

  it('keeps overlapping organization callers separate and never falls back to a previous result', async () => {
    const a = fixture('PHARMACY', { organizationId: 'org-a', salesMinor: 111 });
    const b = fixture('PHARMACY', { organizationId: 'org-b', salesMinor: 222 });
    const [aReport, bReport, aSignals, bSignals] = await Promise.all([
      a.caller.pharmacyReports.commandCentre(a.range),
      b.caller.pharmacyReports.commandCentre(b.range),
      a.caller.pharmacyReports.anomalySignals(a.range),
      b.caller.pharmacyReports.anomalySignals(b.range),
    ]);
    expect(aReport.metrics.salesMinor).toBe(111);
    expect(bReport.metrics.salesMinor).toBe(222);
    expect(aSignals.map((row) => row.id)).toEqual(['org-a-signal']);
    expect(bSignals.map((row) => row.id)).toEqual(['org-b-signal']);
    b.db.$queryRaw.mockRejectedValueOnce(new Error('Report storage unavailable'));
    await expect(b.caller.pharmacyReports.commandCentre(b.range)).rejects.toMatchObject({
      message: 'Report storage unavailable',
    });
  });

  it('keeps concurrent Restaurant insights scoped and propagates a later reader failure', async () => {
    const a = fixture('RESTAURANT', { organizationId: 'org-a' });
    const b = fixture('RESTAURANT', { organizationId: 'org-b' });
    const [aReport, bReport] = await Promise.all([
      a.caller.restaurantInsights.readFinancialReport({ branchId: a.branchId, businessDate: day }),
      b.caller.restaurantInsights.readFinancialReport({ branchId: b.branchId, businessDate: day }),
    ]);
    expect(aReport).toMatchObject({ branchId: a.branchId, branchName: 'org-a' });
    expect(bReport).toMatchObject({ branchId: b.branchId, branchName: 'org-b' });
    b.db.insightDailyRollup.findFirst.mockRejectedValueOnce(
      new Error('Insight storage unavailable')
    );
    await expect(
      b.caller.restaurantInsights.readFinancialReport({ branchId: b.branchId, businessDate: day })
    ).rejects.toMatchObject({ message: 'Insight storage unavailable' });
  });
});

describe('existing shared navigation and UI-only assistant state', () => {
  it('keeps licensed Restaurant report/insight navigation independent of assistant state', () => {
    const f = fixture('RESTAURANT');
    for (const open of [false, true]) {
      useAssistant.getState().setOpen(open);
      const paths = visibleNavigation(f.entitlements, 'ADMIN').map((item) => item.href);
      for (const path of ['/restaurant/reports', '/restaurant/insights']) {
        expect(paths).toContain(path);
        expect(hasModule(f.entitlements, moduleForPath(path)!)).toBe(true);
      }
    }
  });

  it('recomputes navigation for the next vertical without retaining Restaurant insights', () => {
    const restaurant = fixture('RESTAURANT');
    const pharmacy = fixture('PHARMACY');
    expect(visibleNavigation(restaurant.entitlements, 'ADMIN').map((item) => item.href)).toContain(
      '/restaurant/insights'
    );
    expect(
      visibleNavigation(pharmacy.entitlements, 'ADMIN').map((item) => item.href)
    ).not.toContain('/restaurant/insights');
  });

  it('opening the UI does not mutate entitlements or execute provider/background work', () => {
    const f = fixture('PHARMACY');
    const snapshot = structuredClone(f.entitlements);
    useAssistant.getState().setOpen(true);
    useAssistant.getState().toggle();
    expect(useAssistant.getState().open).toBe(false);
    expect(f.entitlements).toEqual(snapshot);
    expect(f.db.user.findUnique).not.toHaveBeenCalled();
    expect(f.db.$queryRaw).not.toHaveBeenCalled();
  });
});
