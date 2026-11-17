import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { readPharmacyCashCloseCheck } from './cash-close-check-operations';
import { readPharmacyShiftHandover } from './shift-handover-operations';
vi.mock('./cash-close-check-operations', () => ({ readPharmacyCashCloseCheck: vi.fn() }));
// Same shape the router's scopeFor supplies, including the non-drawer actorId.
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'user-a' };
const drawerScope = { organizationId: 'org-a', branchId: 'branch-a' };
const businessDate = new Date('2026-11-16T00:00:00Z');
const findings = [
  {
    kind: 'VOID_VOLUME' as const,
    severity: 'REVIEW' as const,
    subject: {},
    exactNumbers: { voidCount: 3 },
    explanation: 'Three voids require review.',
  },
];
function fixture() {
  const db = {
    pharmacyDrawerSession: { findFirst: vi.fn(async () => ({ businessDate })), update: vi.fn() },
    $queryRaw: vi.fn(async () => [
      {
        pendingRx: BigInt('2'),
        openOrders: BigInt('3'),
        restockPromises: BigInt('1'),
        expectedMinor: BigInt('1000'),
        countedMinor: BigInt('900'),
        varianceMinor: -BigInt('100'),
      },
    ]),
    $executeRaw: vi.fn(),
  };
  return {
    db,
    read: () => readPharmacyShiftHandover(db as unknown as ScopedDb, scope, 'drawer-a'),
  };
}
beforeEach(() => {
  vi.mocked(readPharmacyCashCloseCheck).mockResolvedValue({
    businessDate: '2026-11-16',
    currency: 'USD',
    policyVersion: 'existing',
    findings,
    branchName: 'Main',
    timezone: 'UTC',
    closed: false,
    closeId: null,
    readOnly: true,
    narrative: 'Existing narrative',
    totals: {
      grossSalesMinor: 0,
      completedSales: 0,
      refundCount: 0,
      refundTotalMinor: 0,
      unmatchedRefundCount: 0,
      voidCount: 3,
      voidValueMinor: 0,
      cashExpectedMinor: 1000,
      cashCountedMinor: 900,
      cashVarianceMinor: -100,
    },
  });
});
describe('drawer handover snapshot', () => {
  it('binds the branch RLS setting before reading the restock snapshot', async () => {
    const f = fixture();
    await f.read();
    const calls = f.db.$queryRaw.mock.calls as unknown as Array<[Prisma.Sql]>;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]![0].sql).toContain("set_config('app.current_branch_id'");
    expect(calls[0]![0].values).toEqual(['branch-a']);
    expect(calls[1]![0].sql).toContain('pharmacy_restock_interests');
  });
  it('uses SQL figures and existing findings without writing or requiring day close', async () => {
    const f = fixture();
    const result = await f.read();
    expect(result).toMatchObject({
      draft: true,
      readOnly: true,
      facts: { pendingRx: 2, openOrders: 3, restockPromises: 1, varianceMinor: -100 },
    });
    expect(result.note).toContain(
      'USD 9.00 counted; USD 10.00 expected; signed variance -USD 1.00'
    );
    expect(result.note).toContain('2 emergency supplies');
    expect(result.note).toContain('3 unfinished customer orders; 1 independent restock promises');
    expect(result.note).toContain(findings[0].explanation);
    expect(result.findings).toBe(findings);
    expect(readPharmacyCashCloseCheck).toHaveBeenLastCalledWith(f.db, scope, businessDate, {
      anonymizeStaff: true,
    });
    expect(f.db.pharmacyDrawerSession.update).not.toHaveBeenCalled();
    expect(f.db.$executeRaw).not.toHaveBeenCalled();
  });
  it('binds tenant, branch and closed drawer before reading any evidence', async () => {
    const f = fixture();
    f.db.pharmacyDrawerSession.findFirst.mockResolvedValue(null as never);
    await expect(f.read()).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Closed drawer not found.',
    });
    expect(f.db.pharmacyDrawerSession.findFirst).toHaveBeenCalledWith({
      where: { ...drawerScope, id: 'drawer-a', status: 'CLOSED' },
      select: { businessDate: true },
    });
    expect(f.db.$queryRaw).not.toHaveBeenCalled();
  });
  it('keeps every raw read parameterized and excludes order allocations from restock promises', async () => {
    const f = fixture();
    await f.read();
    const query = (f.db.$queryRaw.mock.calls as unknown as Array<[Prisma.Sql]>)[1]![0];
    expect(query.values).toEqual([
      'org-a',
      'branch-a',
      'drawer-a',
      'org-a',
      'branch-a',
      'org-a',
      'branch-a',
      'org-a',
      'branch-a',
    ]);
    expect(query.text).toContain('status = \'OPEN\' AND "orderLineId" IS NULL');
    expect(query.text).toContain('counted - expected AS "varianceMinor"');
    expect(query.text).not.toContain('org-a');
  });
  it('refuses unsafe numeric totals instead of rounding money', async () => {
    const f = fixture();
    f.db.$queryRaw.mockResolvedValue([
      {
        pendingRx: BigInt('0'),
        openOrders: BigInt('0'),
        restockPromises: BigInt('0'),
        expectedMinor: BigInt('9007199254740993'),
        countedMinor: BigInt('0'),
        varianceMinor: BigInt('0'),
      },
    ]);
    await expect(f.read()).rejects.toMatchObject({ message: 'Handover figures unavailable.' });
  });
});
