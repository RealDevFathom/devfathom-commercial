import { beforeEach, describe, expect, it, vi } from 'vitest';

const audits = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return {
    ...actual,
    ipFromHeaders: vi.fn(() => null),
    isAuditExcludedPath: vi.fn(() => false),
    recordTrpcAudit: vi.fn((entry: Parameters<typeof actual.recordTrpcAudit>[0]) => {
      audits.rows.push({
        input: entry.ctx.audit?.detail.skipInput ? '[skipped]' : entry.input,
        metadata: entry.ctx.audit?.detail.metadata,
        outcome: entry.outcome,
      });
    }),
  };
});
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: vi.fn(),
}));

import { can } from '@/lib/abac';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
const groupBy = vi.fn();
const db = {
  pharmacyBranch: {
    findMany: vi.fn().mockResolvedValue([{ id: 'branch-a' }]),
    findFirstOrThrow: vi.fn().mockResolvedValue({ lostSalesUnknownProbability: 0.43,
      lostSalesMeasuredRateMinimum: 200 }),
  },
  $executeRaw: vi.fn().mockResolvedValue(0),
  $queryRaw: vi.fn().mockResolvedValue([]),
  unfulfilledDemandEvent: {
    groupBy,
    findFirst: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn(async ({ data }) => ({ id: 'demand-a', ...data })),
  },
};
const transaction = vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(db));
Object.assign(db, { $transaction: transaction });
function caller(overrides: Partial<TRPCContext> = {}) {
  return app.createCaller({
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'staff-a', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-a' },
    },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
    ...overrides,
  } as unknown as TRPCContext).pharmacySales;
}
beforeEach(() => {
  audits.rows.length = 0;
  db.unfulfilledDemandEvent.create.mockClear();
  vi.mocked(can).mockReset().mockResolvedValue(false);
  groupBy.mockResolvedValue([
    {
      visitId: 'visit-a',
      visitType: 'WALK_OUT',
      outcome: 'WENT_ELSEWHERE',
      requestedMedicineId: 'medicine-a',
      requestedText: null,
      reason: 'STOCKOUT',
      _count: { _all: 1 },
      _sum: {
        quantity: 3,
        requestedQty: 3,
        estimatedValueMinor: 1300,
        estimatedMarginMinor: 100,
        estLossPkr: 13,
        lossProbability: 1,
      },
    },
  ]);
});

describe('demand notification audit privacy', () => {
  const sensitive = {
    branchId: 'branch-a', terminalId: 'counter-11111111-1111-4111-8111-111111111111',
    requestedText: 'Private requested medicine', saleUnit: 'UNIT' as const, quantity: 3,
    reason: 'NOT_CARRIED' as const, inventoryRuleSnapshot: {}, freeText: 'Private patient note',
    notifyPhone: '03001234567',
  };
  it.each([true, false])('audits safe capture metadata with opt-in %s', async (notifyOptIn) => {
    const result = await caller().captureDemand({ ...sensitive, notifyOptIn,
      ...(notifyOptIn ? { notifyConsentRecorded: true as const } : {}) });
    expect(result.notifyPhone).toBe(notifyOptIn ? sensitive.notifyPhone : undefined);
    expect(audits.rows).toEqual([{
      input: '[skipped]', outcome: 'SUCCESS',
      metadata: { quantity: 3, outcome: 'UNKNOWN', visitType: null, notifyOptIn },
    }]);
    expect(JSON.stringify(audits.rows)).not.toContain(sensitive.notifyPhone);
    expect(JSON.stringify(audits.rows)).not.toContain(sensitive.freeText);
  });
  it.each([
    { notifyOptIn: true },
    { notifyOptIn: true, notifyConsentRecorded: true as const, notifyPhone: '123' },
  ])('suppresses sensitive input before validation rejects %j', async (invalid) => {
    await expect(caller().captureDemand({ ...sensitive, ...invalid })).rejects.toThrow();
    expect(db.unfulfilledDemandEvent.create).not.toHaveBeenCalled();
    expect(audits.rows).toEqual([{ input: '[skipped]', metadata: undefined, outcome: 'FAILURE' }]);
  });
  it('suppresses sensitive input on unauthenticated attempts too', async () => {
    await expect(caller({ session: null }).captureDemand(sensitive)).rejects.toThrow();
    expect(audits.rows).toEqual([{ input: '[skipped]', metadata: undefined, outcome: 'FAILURE' }]);
  });
  it('keeps only safe metadata when capture rejects missing notification contact', async () => {
    await expect(caller().captureDemand({
      ...sensitive, notifyPhone: undefined, notifyOptIn: true, notifyConsentRecorded: true,
    })).rejects.toThrow('CONSENT_REQUIRED');
    expect(db.unfulfilledDemandEvent.create).not.toHaveBeenCalled();
    expect(audits.rows).toEqual([{
      input: '[skipped]', outcome: 'FAILURE',
      metadata: { quantity: 3, outcome: 'UNKNOWN', visitType: null, notifyOptIn: true },
    }]);
  });
});
describe('demand financial permission', () => {
  it.each([false, true])(
    'redacts monetary aggregates unless reports:financial is granted (%s)',
    async (allowed) => {
      vi.mocked(can).mockResolvedValue(allowed);
      const result = await caller().demandAggregate({
        branchId: 'branch-a',
        from: new Date('2026-01-01'),
        to: new Date('2026-02-01'),
      });
      expect(can).toHaveBeenCalledWith(
        expect.anything(),
        'reports:financial',
        undefined,
        expect.objectContaining({ db, source: 'TRPC' })
      );
      expect(result.rows[0]?._sum).toMatchObject({
        quantity: 3,
        estimatedValueMinor: allowed ? 1300 : null,
        estimatedMarginMinor: allowed ? 100 : null,
        estLossPkr: allowed ? 13 : null,
      });
    }
  );

  it('expires and aggregates inside one transaction so expiry row locks are retained', async () => {
    transaction.mockClear();
    db.$executeRaw.mockClear();
    let inTransaction = false;
    transaction.mockImplementationOnce(async (run: (tx: unknown) => Promise<unknown>) => {
      inTransaction = true;
      try {
        return await run(db);
      } finally {
        inTransaction = false;
      }
    });
    const lockedInTransaction: boolean[] = [];
    db.$executeRaw.mockImplementation(async () => {
      lockedInTransaction.push(inTransaction);
      return 0;
    });
    await caller().demandAggregate({
      branchId: 'branch-a',
      from: new Date('2026-01-01'),
      to: new Date('2026-02-01'),
    });
    expect(transaction).toHaveBeenCalledOnce();
    expect(lockedInTransaction).toEqual([true, true]);
    db.$executeRaw.mockReset().mockResolvedValue(0);
  });
});
